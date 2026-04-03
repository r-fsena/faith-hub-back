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
  "Access-Control-Allow-Methods": "OPTIONS,POST,GET,PUT"
};

// 1. Convidar Membro
export const invite: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) throw new Error("Missing request body");
    const body = JSON.parse(event.body);
    const { email, name, role, cpf, baptismDate, cellGroupId, phone, invitedBy } = body;

    const command = new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "name", Value: name }
      ],
      DesiredDeliveryMediums: ["EMAIL"]
      // REMOVIDO: MessageAction: "SUPPRESS" para permitir que a AWS envie o e-mail de Boas vindas
    });

    const response = await cognitoClient.send(command);
    const cognitoUserId = response.User?.Username || uuidv4();

    // MySQL Insert
    const insertQuery = `
      INSERT INTO members (id, name, email, role, status, cpf, baptism_date, cell_group_id, phone, invited_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const roleValue = role || 'MEMBER';

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
      invitedBy || null
    ]);

    // Retorna o objeto inserido (Como MySQL2 não suporta RETURNING * pra inserts complexos, construimos local)
    const newUser = { id: cognitoUserId, name, email, role: roleValue, status: 'Pendente', cpf, baptism_date: baptismDate, cell_group_id: cellGroupId, phone, invited_by: invitedBy };

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

// 4. Listar Membros do DB
export const list: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const groupId = event.queryStringParameters?.group_id;
    let listQuery = `SELECT * FROM members `;
    let params: any[] = [];

    if (groupId) {
      listQuery += `WHERE cell_group_id = ? `;
      params.push(groupId);
    }

    listQuery += `ORDER BY name ASC;`;

    const dbResult = await query(listQuery, params);

    return { statusCode: 200, headers, body: JSON.stringify({ data: dbResult.rows }) };
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

    return { statusCode: 200, headers, body: JSON.stringify({ data: dbResult.rows[0] }) };
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

    if (!event.body) throw new Error("Missing request body");
    const { name, cpf, baptismDate, cellGroupId, role, phone } = JSON.parse(event.body);

    // Convert undefined to null for binding in mySQL
    const pName = name !== undefined ? name : null;
    const pCpf = cpf !== undefined ? cpf : null;
    const pBaptism = baptismDate !== undefined ? baptismDate : null;
    const pCell = cellGroupId !== undefined ? cellGroupId : null;
    const pRole = role !== undefined ? role : null;
    const pPhone = phone !== undefined ? phone : null;

    const updateQuery = `
      UPDATE members 
      SET 
        name = COALESCE(?, name),
        cpf = COALESCE(?, cpf),
        baptism_date = COALESCE(?, baptism_date),
        cell_group_id = COALESCE(?, cell_group_id),
        role = COALESCE(?, role),
        phone = COALESCE(?, phone),
        updated_at = NOW()
      WHERE id = ?
    `;

    await query(updateQuery, [pName, pCpf, pBaptism, pCell, pRole, pPhone, id]);

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
