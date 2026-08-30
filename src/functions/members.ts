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
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from "../services/authMiddleware";
import { logSecurityEvent } from "../services/auditLogService";

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || "us-east-2" });
const USER_POOL_ID = process.env.USER_POOL_ID as string;

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS,POST,GET,PUT,DELETE",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token"
};

const LEADERSHIP_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER'];

// 1. Convidar Membro (Protegido por Role e Tenant)
export const invite: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const auth = await requireAuth(event as any);
    if ('errorResponse' in auth) {
      return { statusCode: auth.errorResponse.statusCode, headers, body: auth.errorResponse.body };
    }

    const roleCheck = enforceRole(auth.user, LEADERSHIP_ROLES);
    if (!roleCheck.allowed) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Acesso negado para convidar membros" }) };
    }

    if (!event.body) throw new Error("Missing request body");
    const body = JSON.parse(event.body);
    const { email, name, role, cpf, baptismDate, cellGroupId, phone, invitedBy, organization_id, campus_id, campus_ids } = body;

    const tenantCheck = enforceTenant(auth.user, organization_id);
    if (!tenantCheck.allowed) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Acesso negado: organização inválida" }) };
    }
    const orgValue = tenantCheck.effectiveOrgId;

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

    let roleValue = role || 'MEMBER';
    // Anti-Privilege Escalation: Apenas SuperAdmins podem atribuir o papel de SUPERADMIN
    if (String(roleValue).toUpperCase() === 'SUPERADMIN' && !auth.user.isSuperAdmin) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Apenas SuperAdmins podem conceder permissão de SUPERADMIN" }) };
    }

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
      invitedBy || auth.user.email,
      orgValue,
      primaryCampus,
      campusIdsJson
    ]);

    await logSecurityEvent({
      organizationId: orgValue,
      user: auth.user,
      action: 'INVITE_MEMBER',
      resource: 'members',
      resourceId: cognitoUserId,
      details: { email, name, role: roleValue },
      event: event as any
    });

    const newUser = { id: cognitoUserId, name, email, role: roleValue, status: 'Pendente', cpf, baptism_date: baptismDate, cell_group_id: cellGroupId, phone, invited_by: invitedBy, organization_id: orgValue, campus_id: primaryCampus, campus_ids: campusList };

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({ message: "Membro convidado com sucesso", user: newUser }),
    };
  } catch (error: any) {
    console.error('Erro ao convidar membro:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Erro ao convidar membro" }) };
  }
};

// 2. Atualizar Status (Inativar/Reativar)
export const updateStatus: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const auth = await requireAuth(event as any);
    if ('errorResponse' in auth) {
      return { statusCode: auth.errorResponse.statusCode, headers, body: auth.errorResponse.body };
    }

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN']);
    if (!roleCheck.allowed) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Acesso negado para alterar status de membros" }) };
    }

    if (!event.body) throw new Error("Missing request body");
    const { email, action } = JSON.parse(event.body);

    const { rows: memberRows } = await query(`SELECT organization_id FROM members WHERE email = ? LIMIT 1`, [email]);
    if (memberRows.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Membro não encontrado" }) };
    }

    const tenantCheck = enforceTenant(auth.user, memberRows[0].organization_id);
    if (!tenantCheck.allowed) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Acesso negado a membros de outra organização" }) };
    }

    const CommandClass = action === 'disable' ? AdminDisableUserCommand : AdminEnableUserCommand;
    const command = new CommandClass({
      UserPoolId: USER_POOL_ID,
      Username: email
    });
    await cognitoClient.send(command);

    const statusValue = action === 'disable' ? 'INACTIVE' : 'ACTIVE';
    const updateQuery = `UPDATE members SET status = ?, updated_at = NOW() WHERE email = ?`;
    await query(updateQuery, [statusValue, email]);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: action === 'disable' ? 'DISABLE_MEMBER' : 'ENABLE_MEMBER',
      resource: 'members',
      details: { email, new_status: statusValue },
      event: event as any
    });

    return { statusCode: 200, headers, body: JSON.stringify({ message: `Status alterado para ${action}` }) };
  } catch (error: any) {
    console.error('Erro ao atualizar status do membro:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Erro ao atualizar status do membro" }) };
  }
};

// 3. Reset de Senha Forçado
export const resetPassword: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const auth = await requireAuth(event as any);
    if ('errorResponse' in auth) {
      return { statusCode: auth.errorResponse.statusCode, headers, body: auth.errorResponse.body };
    }

    if (!event.body) throw new Error("Missing request body");
    const { email } = JSON.parse(event.body);

    const command = new AdminResetUserPasswordCommand({
      UserPoolId: USER_POOL_ID,
      Username: email
    });
    await cognitoClient.send(command);

    return { statusCode: 200, headers, body: JSON.stringify({ message: "E-mail de redefinição enviado pelo AWS Cognito." }) };
  } catch (error: any) {
    console.error('Erro ao solicitar reset de senha:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Erro ao processar reset de senha" }) };
  }
};

// 4. Listar Membros do DB com suporte a Campus/Organização
export const list: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const auth = await requireAuth(event as any);
    if ('errorResponse' in auth) {
      return { statusCode: auth.errorResponse.statusCode, headers, body: auth.errorResponse.body };
    }

    const groupId = event.queryStringParameters?.group_id;
    const campusId = event.queryStringParameters?.campus_id;
    const requestedOrgId = event.queryStringParameters?.organization_id;
    const email = event.queryStringParameters?.email;

    const tenantCheck = enforceTenant(auth.user, requestedOrgId);
    if (!tenantCheck.allowed) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Acesso negado à congregação" }) };
    }
    const orgId = tenantCheck.effectiveOrgId;

    let listQuery = `
      SELECT m.*, cg.name as cell_group_name, c.name as campus_name
      FROM members m
      LEFT JOIN cell_groups cg ON m.cell_group_id = cg.id
      LEFT JOIN campuses c ON m.campus_id = c.id
      WHERE m.organization_id = ?
    `;
    let params: any[] = [orgId];

    if (email) {
      listQuery += ` AND m.email = ?`;
      params.push(email);
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
    console.error('Erro ao listar membros:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Erro ao listar membros" }) };
  }
};

// 5. Obter Detalhes
export const get: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const auth = await requireAuth(event as any);
    if ('errorResponse' in auth) {
      return { statusCode: auth.errorResponse.statusCode, headers, body: auth.errorResponse.body };
    }

    const rawId = event.pathParameters?.id;
    if (!rawId) throw new Error("Missing member ID");

    const effectiveId = (rawId === 'me' || rawId === 'user_me') ? auth.user.userId : rawId;
    const effectiveEmail = (rawId === 'me' || rawId === 'user_me') ? (auth.user.email || '') : '';

    const getQuery = `
      SELECT m.*, cg.name as cell_group_name 
      FROM members m 
      LEFT JOIN cell_groups cg ON m.cell_group_id = cg.id 
      WHERE (m.id = ? AND m.id != '') OR (m.email IS NOT NULL AND LOWER(m.email) = LOWER(?))
      LIMIT 1;
    `;
    const dbResult = await query(getQuery, [effectiveId, effectiveEmail || effectiveId]);

    if (dbResult.rows.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ message: "Membro não encontrado" }) };
    }

    const memberData = dbResult.rows[0];

    const tenantCheck = enforceTenant(auth.user, memberData.organization_id);
    if (!tenantCheck.allowed) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Acesso negado" }) };
    }

    memberData.campus_ids = typeof memberData.campus_ids === 'string' ? JSON.parse(memberData.campus_ids || '[]') : (memberData.campus_ids || []);

    return { statusCode: 200, headers, body: JSON.stringify({ data: memberData }) };
  } catch (error: any) {
    console.error('Erro ao buscar detalhes do membro:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Erro ao buscar membro" }) };
  }
};

// 6. Atualizar Perfil
export const update: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const auth = await requireAuth(event as any);
    if ('errorResponse' in auth) {
      return { statusCode: auth.errorResponse.statusCode, headers, body: auth.errorResponse.body };
    }

    const id = event.pathParameters?.id;
    if (!id) throw new Error("Missing member ID");

    const { rows: existingRows } = await query(`SELECT organization_id FROM members WHERE id = ? LIMIT 1`, [id]);
    if (existingRows.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Membro não encontrado" }) };
    }

    const isSelf = auth.user.userId === id;
    const isLeadership = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER'].includes(auth.user.role);

    if (!isSelf && !isLeadership) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Permissão insuficiente para alterar outro perfil" }) };
    }

    const tenantCheck = enforceTenant(auth.user, existingRows[0].organization_id);
    if (!tenantCheck.allowed) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Acesso negado" }) };
    }

    const body = JSON.parse(event.body || '{}');
    const { name, cpf, baptismDate, cellGroupId, role, phone, address, avatar_url, campus_id, campus_ids } = body;

    // Membro regular não pode alterar o próprio papel (Role escalation prevention)
    if (role && String(role).toUpperCase() === 'SUPERADMIN' && !auth.user.isSuperAdmin) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Apenas SuperAdmins podem conceder permissão de SUPERADMIN" }) };
    }
    const pRole = isLeadership && role !== undefined ? role : null;

    const pName = name !== undefined ? name : null;
    const pCpf = cpf !== undefined ? cpf : null;
    const pBaptism = baptismDate !== undefined ? baptismDate : null;
    const pCell = cellGroupId !== undefined ? cellGroupId : null;
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

    await logSecurityEvent({
      organizationId: existingRows[0].organization_id,
      user: auth.user,
      action: 'UPDATE_MEMBER_PROFILE',
      resource: 'members',
      resourceId: id,
      event: event as any
    });

    return { statusCode: 200, headers, body: JSON.stringify({ message: "Perfil atualizado", id }) };
  } catch (error: any) {
    console.error('Erro ao atualizar membro:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Erro ao atualizar membro" }) };
  }
};

// 7. Solicitar Participação em Célula (App Mobile & PWA)
export const requestCell: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const user = await getAuthenticatedUser(event as any);
    const pathId = event.pathParameters?.id;
    const body = JSON.parse(event.body || '{}');
    const { cellGroupId, email: bodyEmail, userId: bodyUserId } = body;

    if (!cellGroupId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "cellGroupId é obrigatório" }) };
    }

    const effectiveEmail = user?.email || bodyEmail || '';
    const effectiveId = user?.userId || bodyUserId || (pathId && pathId !== 'me' && pathId !== 'user_me' ? pathId : '');

    // Busca o registro do membro por ID ou por E-mail
    const { rows } = await query(
      `SELECT id, organization_id, name, email FROM members 
       WHERE (id = ? AND id != '') 
          OR (email IS NOT NULL AND LOWER(email) = LOWER(?)) 
       LIMIT 1`,
      [effectiveId, effectiveEmail]
    );

    let targetMemberId = '';

    if (rows.length > 0) {
      targetMemberId = rows[0].id;
      await query(
        `UPDATE members SET pending_cell_group_id = ?, updated_at = NOW() WHERE id = ?`,
        [cellGroupId, targetMemberId]
      );
    } else {
      // Se ainda não estava cadastrado na tabela de membros, cria com pending_cell_group_id
      targetMemberId = effectiveId || uuidv4();
      const orgId = user?.organizationId || 'org_default';
      const memberName = user?.name || (effectiveEmail ? effectiveEmail.split('@')[0] : 'Novo Membro');

      await query(
        `INSERT INTO members (id, name, email, role, status, organization_id, campus_id, pending_cell_group_id, created_at, updated_at)
         VALUES (?, ?, ?, 'Membro', 'ACTIVE', ?, 'campus_sede', ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE pending_cell_group_id = VALUES(pending_cell_group_id), updated_at = NOW()`,
        [targetMemberId, memberName, effectiveEmail || null, orgId, cellGroupId]
      );
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "Solicitação de entrada enviada com sucesso!",
        member_id: targetMemberId,
        cell_group_id: cellGroupId
      })
    };
  } catch (error: any) {
    console.error('Erro ao solicitar célula:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Erro ao processar solicitação de célula" }) };
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
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Erro ao sincronizar membro" }) };
  }
};
