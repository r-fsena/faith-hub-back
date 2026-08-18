import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminResetUserPasswordCommand
} from "@aws-sdk/client-cognito-identity-provider";
import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { query } from "../db";
import { v4 as uuidv4 } from "uuid";

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || "us-east-2" });
const USER_POOL_ID = process.env.USER_POOL_ID as string;

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS,POST,GET,PUT,DELETE",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token"
};

// 1. Convidar Membro
export const invite: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) throw new Error("Missing request body");
    const body = JSON.parse(event.body);
    const { email, name, role, cpf, baptismDate, cellGroupId, phone, invitedBy, organization_id, campus_id, campus_ids } = body;

    const command = new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "name", Value: name },
        { Name: "email_verified", Value: "true" }
      ],
      DesiredDeliveryMediums: ["EMAIL"]
    });

    const response = await cognitoClient.send(command);
    const cognitoUserId = response.User?.Username || uuidv4();

    const roleValue = role || 'MEMBER';
    const orgValue = organization_id || 'org_default';
    const campusList = Array.isArray(campus_ids) && campus_ids.length > 0 
      ? campus_ids 
      : (campus_id ? [campus_id] : ['campus_sede']);
    const primaryCampus = campusList[0] || 'campus_sede';
    const campusIdsJson = JSON.stringify(campusList);

    // MySQL Insert
    const insertQuery = `
      INSERT INTO members (id, name, email, role, status, cpf, baptism_date, cell_group_id, phone, invited_by, organization_id, campus_id, campus_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await query(insertQuery, [
      cognitoUserId,
      name,
      email,
      roleValue,
      'Pendente',
      cpf || null,
      baptismDate || null,
      cellGroupId || null,
      phone || null,
      invitedBy || null,
      orgValue,
      primaryCampus,
      campusIdsJson
    ]);

    const newUser = { id: cognitoUserId, name, email, role: roleValue, status: 'Pendente', cpf, baptism_date: baptismDate, cell_group_id: cellGroupId, phone, invited_by: invitedBy, organization_id: orgValue, campus_id: primaryCampus, campus_ids: campusList };

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({ message: "Membro convidado com sucesso", user: newUser }),
    };
  } catch (error: any) {
    console.error(error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};

// 2. Atualizar Status (Inativar/Reativar)
export const updateStatus: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) throw new Error("Missing request body");
    const { email, action } = JSON.parse(event.body);

    const CommandClass = action === 'disable' ? AdminDisableUserCommand : AdminEnableUserCommand;
    const command = new CommandClass({
      UserPoolId: USER_POOL_ID,
      Username: email
    });
    await cognitoClient.send(command);

    // MySQL Update
    const statusValue = action === 'disable' ? 'INACTIVE' : 'ACTIVE';
    const updateQuery = `UPDATE members SET status = ?, updated_at = NOW() WHERE email = ?`;
    await query(updateQuery, [statusValue, email]);

    return { statusCode: 200, headers, body: JSON.stringify({ message: `Status alterado para ${action}` }) };
  } catch (error: any) {
    console.error(error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};

// 3. Reset de Senha Forçado
export const resetPassword: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) throw new Error("Missing request body");
    const { email } = JSON.parse(event.body);

    const command = new AdminResetUserPasswordCommand({
      UserPoolId: USER_POOL_ID,
      Username: email
    });
    await cognitoClient.send(command);

    return { statusCode: 200, headers, body: JSON.stringify({ message: "E-mail de redefinição enviado pelo AWS Cognito." }) };
  } catch (error: any) {
    console.error(error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};

// 4. Listar Membros do DB com suporte a Campus/Organização
export const list: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const groupId = event.queryStringParameters?.group_id;
    const campusId = event.queryStringParameters?.campus_id;
    const orgId = event.queryStringParameters?.organization_id;
    const email = event.queryStringParameters?.email;

    let listQuery = `
      SELECT m.*, cg.name as cell_group_name, c.name as campus_name
      FROM members m
      LEFT JOIN cell_groups cg ON m.cell_group_id = cg.id
      LEFT JOIN campuses c ON m.campus_id = c.id
      WHERE 1=1
    `;
    let params: any[] = [];

    if (email) {
      listQuery += ` AND m.email = ?`;
      params.push(email);
    }

    if (orgId && orgId !== 'all') {
      listQuery += ` AND m.organization_id = ?`;
      params.push(orgId);
    }

    if (campusId && campusId !== 'all') {
      listQuery += ` AND (m.campus_id = ? OR JSON_CONTAINS(m.campus_ids, JSON_QUOTE(?)) OR JSON_CONTAINS(m.campus_ids, '"all"'))`;
      params.push(campusId, campusId);
    }

    if (groupId) {
      listQuery += ` AND m.cell_group_id = ?`;
      params.push(groupId);
    }

    listQuery += ` ORDER BY m.name ASC;`;

    const dbResult = await query(listQuery, params);

    const formattedMembers = dbResult.rows.map((m: any) => ({
      ...m,
      campus_ids: typeof m.campus_ids === 'string' ? JSON.parse(m.campus_ids || '[]') : (m.campus_ids || [])
    }));

    return { statusCode: 200, headers, body: JSON.stringify({ data: formattedMembers }) };
  } catch (error: any) {
    console.error(error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};

// 5. Obter Detalhes
export const get: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const id = event.pathParameters?.id;
    if (!id) throw new Error("Missing member ID");

    const getQuery = `
      SELECT m.*, cg.name as cell_group_name 
      FROM members m 
      LEFT JOIN cell_groups cg ON m.cell_group_id = cg.id 
      WHERE m.id = ? LIMIT 1;
    `;
    const dbResult = await query(getQuery, [id]);

    if (dbResult.rows.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ message: "Membro não encontrado" }) };
    }

    const memberData = dbResult.rows[0];
    memberData.campus_ids = typeof memberData.campus_ids === 'string' ? JSON.parse(memberData.campus_ids || '[]') : (memberData.campus_ids || []);

    return { statusCode: 200, headers, body: JSON.stringify({ data: memberData }) };
  } catch (error: any) {
    console.error(error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};

// 6. Atualizar Perfil
export const update: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const id = event.pathParameters?.id;
    if (!id) throw new Error("Missing member ID");

    const { name, cpf, baptismDate, cellGroupId, role, phone, address, avatar_url, campus_id, campus_ids } = JSON.parse(event.body);

    // Convert undefined to null for binding in mySQL
    const pName = name !== undefined ? name : null;
    const pCpf = cpf !== undefined ? cpf : null;
    const pBaptism = baptismDate !== undefined ? baptismDate : null;
    const pCell = cellGroupId !== undefined ? cellGroupId : null;
    const pRole = role !== undefined ? role : null;
    const pPhone = phone !== undefined ? phone : null;
    const pAddress = address !== undefined ? address : null;
    const pAvatar = avatar_url !== undefined ? avatar_url : null;
    const pCampus = campus_id !== undefined ? campus_id : null;
    const pCampusIds = campus_ids !== undefined ? JSON.stringify(campus_ids) : null;

    const updateQuery = `
      UPDATE members 
      SET 
        name = COALESCE(?, name),
        cpf = COALESCE(?, cpf),
        baptism_date = COALESCE(?, baptism_date),
        cell_group_id = COALESCE(?, cell_group_id),
        role = COALESCE(?, role),
        phone = COALESCE(?, phone),
        address = COALESCE(?, address),
        avatar_url = COALESCE(?, avatar_url),
        campus_id = COALESCE(?, campus_id),
        campus_ids = COALESCE(?, campus_ids),
        updated_at = NOW()
      WHERE id = ?
    `;

    await query(updateQuery, [pName, pCpf, pBaptism, pCell, pRole, pPhone, pAddress, pAvatar, pCampus, pCampusIds, id]);

    return { statusCode: 200, headers, body: JSON.stringify({ message: "Perfil atualizado", id }) };
  } catch (error: any) {
    console.error(error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};

// 7. Solicitar Participação em Célula (App Mobile)
export const requestCell: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const id = event.pathParameters?.id;
    if (!id) throw new Error("Missing member ID");

    if (!event.body) throw new Error("Missing request body");
    const { cellGroupId } = JSON.parse(event.body);

    const q = `UPDATE members SET pending_cell_group_id = ? WHERE id = ?`;
    const result: any = await query(q, [cellGroupId, id]);

    if (result.rows.affectedRows === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Membro não encontrado no banco de dados. Sincronize seu cadastro." }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ message: "Solicitação enviada com sucesso" }) };
  } catch (error: any) {
    console.error(error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};

// 8. Auto-cadastro / Sincronização de usuário logado (PWA / Mobile)
export const selfRegister: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) throw new Error("Missing request body");
    const { id, email, name, phone, birthdate, address, organization_id, campus_id } = JSON.parse(event.body);

    if (!email) throw new Error("Email is required");

    const memberId = id || uuidv4();
    const memberName = name || email.split('@')[0];
    const orgValue = organization_id || 'org_default';
    const primaryCampus = campus_id || 'campus_sede';
    const campusIdsJson = JSON.stringify([primaryCampus]);

    // Verifica se já existe por email ou id
    const checkSql = `SELECT id FROM members WHERE id = ? OR LOWER(email) = LOWER(?) LIMIT 1`;
    const checkRes = await query(checkSql, [memberId, email]);

    if (checkRes.rows.length === 0) {
      const insertSql = `
        INSERT INTO members (id, name, email, phone, address, role, status, organization_id, campus_id, campus_ids)
        VALUES (?, ?, ?, ?, ?, 'Membro', 'Ativo', ?, ?, ?)
      `;
      await query(insertSql, [memberId, memberName, email, phone || null, address || null, orgValue, primaryCampus, campusIdsJson]);
    } else {
      const existingId = checkRes.rows[0].id;
      const updateSql = `
        UPDATE members 
        SET 
          name = COALESCE(?, name),
          phone = COALESCE(?, phone),
          address = COALESCE(?, address),
          status = 'Ativo',
          updated_at = NOW()
        WHERE id = ?
      `;
      await query(updateSql, [name || null, phone || null, address || null, existingId]);
    }

    if (birthdate) {
      try {
        await query(
          `INSERT INTO member_details (member_id, birth_date) VALUES (?, ?) ON DUPLICATE KEY UPDATE birth_date = ?`,
          [memberId, birthdate, birthdate]
        );
      } catch (e) {}
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ message: "Membro sincronizado com sucesso", id: memberId })
    };
  } catch (error: any) {
    console.error("Erro no selfRegister:", error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};

