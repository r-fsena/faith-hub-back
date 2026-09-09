import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminResetUserPasswordCommand,
  AdminGetUserCommand
} from "@aws-sdk/client-cognito-identity-provider";
import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { query } from "../db";
import { v4 as uuidv4 } from "uuid";
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from "../services/authMiddleware";
import { logSecurityEvent } from "../services/auditLogService";
import { checkRateLimit } from "../services/rateLimiter";

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
    const { 
      email, name, role, cpf, baptismDate, cellGroupId, phone, invitedBy, 
      birth_date, birthDate,
      address_street, address_number, address_complement, address_neighborhood, address_city, address_state, address_zip, address,
      organization_id, campus_id, campus_ids 
    } = body;

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
    // Anti-Privilege Escalation: Apenas SuperAdmins podem atribuir papéis de administração Master
    const isMasterRole = ['SUPERADMIN', 'SUPER_ADMIN', 'MASTER_ADMIN', 'MASTER', 'ADMIN_MASTER'].includes(String(roleValue).toUpperCase());
    if (isMasterRole && !auth.user.isSuperAdmin) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Apenas Administradores Master podem conceder permissões globais" }) };
    }

    const campusList = Array.isArray(campus_ids) && campus_ids.length > 0 
      ? campus_ids 
      : (campus_id ? [campus_id] : ['campus_sede']);
    const primaryCampus = campusList[0] || 'campus_sede';
    const campusIdsJson = JSON.stringify(campusList);

    const pBirthDate = birth_date || birthDate || null;
    const pStreet = address_street || null;
    const pNumber = address_number || null;
    const pComplement = address_complement || null;
    const pNeighborhood = address_neighborhood || null;
    const pCity = address_city || null;
    const pState = address_state || null;
    const pZip = address_zip || null;
    const pAddressFull = address || (pStreet ? `${pStreet}, ${pNumber || 'S/N'}${pComplement ? ` - ${pComplement}` : ''} - ${pNeighborhood || ''}, ${pCity || ''} - ${pState || ''}` : null);

    // MySQL Insert
    const insertQuery = `
      INSERT INTO members (
        id, name, email, role, status, cpf, baptism_date, cell_group_id, phone, invited_by, 
        birth_date, address_street, address_number, address_complement, address_neighborhood, address_city, address_state, address_zip, address,
        organization_id, campus_id, campus_ids
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      pBirthDate,
      pStreet,
      pNumber,
      pComplement,
      pNeighborhood,
      pCity,
      pState,
      pZip,
      pAddressFull,
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

    const newUser = { 
      id: cognitoUserId, name, email, role: roleValue, status: 'Pendente', 
      cpf, baptism_date: baptismDate, cell_group_id: cellGroupId, phone, invited_by: invitedBy, 
      birth_date: pBirthDate, address_street: pStreet, address_number: pNumber, address_complement: pComplement, address_neighborhood: pNeighborhood, address_city: pCity, address_state: pState, address_zip: pZip, address: pAddressFull,
      organization_id: orgValue, campus_id: primaryCampus, campus_ids: campusList 
    };

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

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN', 'MASTER_ADMIN', 'SUPER_ADMIN', 'MASTER', 'ADMIN_MASTER']);
    if (!roleCheck.allowed) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Acesso negado para alterar status de membros" }) };
    }

    if (!event.body) throw new Error("Missing request body");
    const { email, action } = JSON.parse(event.body);
    const cleanEmail = String(email || '').trim().toLowerCase();

    if (!cleanEmail) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "E-mail é obrigatório" }) };
    }

    const { rows: memberRows } = await query(
      `SELECT id, organization_id, email, status FROM members WHERE LOWER(TRIM(email)) = ? LIMIT 1`, 
      [cleanEmail]
    );

    if (memberRows.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Membro não encontrado no banco de dados" }) };
    }

    const targetOrgId = memberRows[0].organization_id;
    // Master admins/Superadmins can manage any member, including other master users
    const isMasterTarget = targetOrgId === 'org_master';
    if (isMasterTarget && !auth.user.isSuperAdmin) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Apenas administradores Master podem alterar o status de outro Master" }) };
    }

    const tenantCheck = enforceTenant(auth.user, targetOrgId);
    if (!tenantCheck.allowed) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Acesso negado a membros de outra organização" }) };
    }

    // 1. Tenta atualizar no Cognito com resolução segura de Username
    try {
      let targetUsername = cleanEmail;
      try {
        const cognitoUser = await cognitoClient.send(new AdminGetUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: cleanEmail
        }));
        if (cognitoUser?.Username) {
          targetUsername = cognitoUser.Username;
        }
      } catch (err: any) {
        console.warn(`[UPDATE_STATUS] Usuário ${cleanEmail} não localizado no Cognito por email:`, err.message);
      }

      const CommandClass = action === 'disable' ? AdminDisableUserCommand : AdminEnableUserCommand;
      await cognitoClient.send(new CommandClass({
        UserPoolId: USER_POOL_ID,
        Username: targetUsername
      }));
    } catch (cognitoError: any) {
      console.warn(`[UPDATE_STATUS] Aviso ao sincronizar com Cognito para ${cleanEmail}:`, cognitoError.name, cognitoError.message);
      // Se não encontrado no Cognito, não impede a alteração de status no banco
    }

    // 2. Atualiza no MySQL DB
    const statusValue = action === 'disable' ? 'INACTIVE' : 'ACTIVE';
    const updateQuery = `UPDATE members SET status = ?, updated_at = NOW() WHERE LOWER(TRIM(email)) = ?`;
    await query(updateQuery, [statusValue, cleanEmail]);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: action === 'disable' ? 'DISABLE_MEMBER' : 'ENABLE_MEMBER',
      resource: 'members',
      details: { email: cleanEmail, new_status: statusValue },
      event: event as any
    });

    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({ 
        message: `Status alterado para ${statusValue} com sucesso.` 
      }) 
    };
  } catch (error: any) {
    console.error('Erro ao atualizar status do membro:', error);
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ error: error.message || "Erro ao atualizar status do membro" }) 
    };
  }
};

// 3. Reset de Senha / Reenvio de Convite
export const resetPassword: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const rateLimit = checkRateLimit(event as any, {
      maxRequests: 10,
      windowSeconds: 60,
      identifierPrefix: 'reset-password'
    });
    if (!rateLimit.allowed) {
      return {
        statusCode: rateLimit.errorResponse?.statusCode || 429,
        headers,
        body: rateLimit.errorResponse?.body || JSON.stringify({ error: "Muitas tentativas de reset. Aguarde um instante." })
      };
    }

    const auth = await requireAuth(event as any);
    if ('errorResponse' in auth) {
      return { statusCode: auth.errorResponse.statusCode, headers, body: auth.errorResponse.body };
    }

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN', 'MASTER_ADMIN', 'SUPER_ADMIN', 'MASTER', 'ADMIN_MASTER']);
    if (!roleCheck.allowed) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Acesso negado para redefinir senhas" }) };
    }

    if (!event.body) throw new Error("Missing request body");
    const { email } = JSON.parse(event.body);
    const cleanEmail = String(email || '').trim().toLowerCase();

    if (!cleanEmail) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "E-mail obrigatório" }) };
    }

    // Identifica o status atual do usuário no Cognito
    let cognitoUser: any = null;
    try {
      cognitoUser = await cognitoClient.send(new AdminGetUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: cleanEmail
      }));
    } catch (err: any) {
      console.warn(`[RESET_PASSWORD] Usuário ${cleanEmail} não encontrado inicialmente pelo email:`, err.message);
    }

    const targetUsername = cognitoUser?.Username || cleanEmail;
    const userStatus = cognitoUser?.UserStatus;

    // Se o usuário estiver em FORCE_CHANGE_PASSWORD (ainda não concluiu primeiro acesso),
    // o comando AdminResetUserPassword falha por restrição da AWS.
    // O comando correto é AdminCreateUserCommand com MessageAction: 'RESEND' usando o e-mail.
    if (userStatus === 'FORCE_CHANGE_PASSWORD') {
      await cognitoClient.send(new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: cleanEmail,
        MessageAction: 'RESEND'
      }));
      return { 
        statusCode: 200, 
        headers, 
        body: JSON.stringify({ message: "Convite e senha provisória reenviados com sucesso pelo AWS Cognito." }) 
      };
    }

    // Se já estiver confirmado ou em outro estado, envia o reset padrão
    try {
      const command = new AdminResetUserPasswordCommand({
        UserPoolId: USER_POOL_ID,
        Username: cleanEmail
      });
      await cognitoClient.send(command);
      return { 
        statusCode: 200, 
        headers, 
        body: JSON.stringify({ message: "E-mail de redefinição enviado com sucesso pelo AWS Cognito." }) 
      };
    } catch (resetErr: any) {
      // Fallback: se o reset falhar por estado não confirmado, tenta RESEND usando o e-mail
      if (resetErr.name === 'NotAuthorizedException' || resetErr.message?.includes('cannot be reset')) {
        await cognitoClient.send(new AdminCreateUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: cleanEmail,
          MessageAction: 'RESEND'
        }));
        return { 
          statusCode: 200, 
          headers, 
          body: JSON.stringify({ message: "Convite de ativação reenviado com sucesso pelo AWS Cognito." }) 
        };
      }
      throw resetErr;
    }
  } catch (error: any) {
    console.error('Erro ao solicitar reset de senha:', error);
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ error: error.message || "Erro ao processar reenvio de acesso" }) 
    };
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
    const birthdays = event.queryStringParameters?.birthdays; // 'today', 'month', 'upcoming'
    const birthMonth = event.queryStringParameters?.birth_month;
    const isMaster = event.queryStringParameters?.is_master === 'true' || requestedOrgId === 'org_master';

    // Se for listagem da Equipe Master Global (Studio)
    if (isMaster) {
      if (!auth.user.isSuperAdmin) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: "Acesso negado: apenas administradores Master podem visualizar a equipe global" }) };
      }
      const dbResult = await query(`
        SELECT id, name, email, role, status, phone, organization_id, campus_id, created_at, updated_at
        FROM members
        WHERE organization_id = 'org_master' 
           OR role IN ('SUPERADMIN', 'SUPER_ADMIN', 'MASTER_ADMIN', 'MASTER', 'ADMIN_MASTER')
        ORDER BY created_at ASC
      `);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: dbResult.rows })
      };
    }

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

    if (birthdays === 'today') {
      listQuery += ` AND m.birth_date IS NOT NULL AND MONTH(m.birth_date) = MONTH(CURRENT_DATE()) AND DAY(m.birth_date) = DAY(CURRENT_DATE())`;
      listQuery += ` ORDER BY m.name ASC;`;
    } else if (birthdays === 'month') {
      listQuery += ` AND m.birth_date IS NOT NULL AND MONTH(m.birth_date) = MONTH(CURRENT_DATE())`;
      listQuery += ` ORDER BY DAY(m.birth_date) ASC, m.name ASC;`;
    } else if (birthMonth) {
      listQuery += ` AND m.birth_date IS NOT NULL AND MONTH(m.birth_date) = ?`;
      params.push(parseInt(birthMonth));
      listQuery += ` ORDER BY DAY(m.birth_date) ASC, m.name ASC;`;
    } else {
      listQuery += ` ORDER BY m.name ASC;`;
    }

    const dbResult = await query(listQuery, params);

    const formattedMembers = dbResult.rows.map((m: any) => ({
      ...m,
      birth_date: m.birth_date 
        ? (m.birth_date instanceof Date ? m.birth_date.toISOString().split('T')[0] : String(m.birth_date).split('T')[0])
        : null,
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
    const { 
      name, cpf, baptismDate, cellGroupId, role, phone, address, avatar_url, campus_id, campus_ids,
      birth_date, birthDate,
      address_street, address_number, address_complement, address_neighborhood, address_city, address_state, address_zip
    } = body;

    // Membro regular não pode alterar o próprio papel (Role escalation prevention)
    const isEscalatingToMaster = ['SUPERADMIN', 'SUPER_ADMIN', 'MASTER_ADMIN', 'MASTER', 'ADMIN_MASTER'].includes(String(role || '').toUpperCase());
    if (role && isEscalatingToMaster && !auth.user.isSuperAdmin) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Apenas SuperAdmins podem conceder permissão Master" }) };
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

    const pBirthDate = birth_date !== undefined ? birth_date : (birthDate !== undefined ? birthDate : null);
    const pStreet = address_street !== undefined ? address_street : null;
    const pNumber = address_number !== undefined ? address_number : null;
    const pComplement = address_complement !== undefined ? address_complement : null;
    const pNeighborhood = address_neighborhood !== undefined ? address_neighborhood : null;
    const pCity = address_city !== undefined ? address_city : null;
    const pState = address_state !== undefined ? address_state : null;
    const pZip = address_zip !== undefined ? address_zip : null;

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
        birth_date = COALESCE(?, birth_date),
        address_street = COALESCE(?, address_street),
        address_number = COALESCE(?, address_number),
        address_complement = COALESCE(?, address_complement),
        address_neighborhood = COALESCE(?, address_neighborhood),
        address_city = COALESCE(?, address_city),
        address_state = COALESCE(?, address_state),
        address_zip = COALESCE(?, address_zip),
        updated_at = NOW()
      WHERE id = ?
    `;

    await query(updateQuery, [
      pName, pCpf, pBaptism, pCell, pRole, pPhone, pAddress, pAvatar, pCampus, pCampusIds,
      pBirthDate, pStreet, pNumber, pComplement, pNeighborhood, pCity, pState, pZip,
      id
    ]);

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
    const rateLimit = checkRateLimit(event as any, {
      maxRequests: 10,
      windowSeconds: 60,
      identifierPrefix: 'self-register'
    });
    if (!rateLimit.allowed) {
      return {
        statusCode: rateLimit.errorResponse?.statusCode || 429,
        headers,
        body: rateLimit.errorResponse?.body || JSON.stringify({ error: "Limite de cadastros por minuto excedido. Aguarde alguns instantes." })
      };
    }

    if (!event.body) throw new Error("Missing request body");
    const { 
      id, email, name, phone, birthdate, birth_date, birthDate, address,
      address_street, address_number, address_complement, address_neighborhood, address_city, address_state, address_zip,
      organization_id, campus_id 
    } = JSON.parse(event.body);

    if (!email) throw new Error("Email is required");

    const memberId = id || uuidv4();
    const memberName = name || email.split('@')[0];
    const orgValue = organization_id || 'org_default';
    const primaryCampus = campus_id || 'campus_sede';
    const campusIdsJson = JSON.stringify([primaryCampus]);

    const effectiveBirthDate = birth_date || birthdate || birthDate || null;
    const pStreet = address_street || null;
    const pNumber = address_number || null;
    const pComplement = address_complement || null;
    const pNeighborhood = address_neighborhood || null;
    const pCity = address_city || null;
    const pState = address_state || null;
    const pZip = address_zip || null;
    const pAddressFull = address || (pStreet ? `${pStreet}, ${pNumber || 'S/N'}${pComplement ? ` - ${pComplement}` : ''} - ${pNeighborhood || ''}, ${pCity || ''} - ${pState || ''}` : null);

    const checkSql = `SELECT id FROM members WHERE id = ? OR LOWER(email) = LOWER(?) LIMIT 1`;
    const checkRes = await query(checkSql, [memberId, email]);

    if (checkRes.rows.length === 0) {
      const insertSql = `
        INSERT INTO members (
          id, name, email, phone, birth_date, 
          address_street, address_number, address_complement, address_neighborhood, address_city, address_state, address_zip, address,
          role, status, organization_id, campus_id, campus_ids
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Membro', 'Ativo', ?, ?, ?)
      `;
      await query(insertSql, [
        memberId, memberName, email, phone || null, effectiveBirthDate,
        pStreet, pNumber, pComplement, pNeighborhood, pCity, pState, pZip, pAddressFull,
        orgValue, primaryCampus, campusIdsJson
      ]);
    } else {
      const existingId = checkRes.rows[0].id;
      const updateSql = `
        UPDATE members 
        SET 
          name = COALESCE(?, name),
          phone = COALESCE(?, phone),
          birth_date = COALESCE(?, birth_date),
          address_street = COALESCE(?, address_street),
          address_number = COALESCE(?, address_number),
          address_complement = COALESCE(?, address_complement),
          address_neighborhood = COALESCE(?, address_neighborhood),
          address_city = COALESCE(?, address_city),
          address_state = COALESCE(?, address_state),
          address_zip = COALESCE(?, address_zip),
          address = COALESCE(?, address),
          status = 'Ativo',
          updated_at = NOW()
        WHERE id = ?
      `;
      await query(updateSql, [
        name || null, phone || null, effectiveBirthDate,
        pStreet, pNumber, pComplement, pNeighborhood, pCity, pState, pZip, pAddressFull,
        existingId
      ]);
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

// 12. Importação de Membros em Lote (Batch Import com Senha Temporária no Cognito)
export const batchImport: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const auth = await requireAuth(event as any);
    if ('errorResponse' in auth) {
      return { statusCode: auth.errorResponse.statusCode, headers, body: auth.errorResponse.body };
    }

    const roleCheck = enforceRole(auth.user, LEADERSHIP_ROLES);
    if (!roleCheck.allowed) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Acesso negado para importar membros" }) };
    }

    if (!event.body) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Corpo da requisição ausente" }) };
    }

    const body = JSON.parse(event.body);
    const { 
      members: rawMembers, 
      defaultPassword = 'MembroFaith@2026', 
      organization_id, 
      campus_id,
      campus_ids
    } = body;

    if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Nenhum membro informado na planilha" }) };
    }

    const tenantCheck = enforceTenant(auth.user, organization_id);
    if (!tenantCheck.allowed) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Acesso negado: organização inválida" }) };
    }
    const orgValue = tenantCheck.effectiveOrgId;

    const campusList = Array.isArray(campus_ids) && campus_ids.length > 0 
      ? campus_ids 
      : (campus_id ? [campus_id] : ['campus_sede']);
    const primaryCampus = campusList[0] || 'campus_sede';
    const campusIdsJson = JSON.stringify(campusList);

    // Mapeia todas as células da organização para associação automática por nome
    const cellGroupsRes = await query(
      `SELECT id, name FROM cell_groups WHERE organization_id = ?`, 
      [orgValue]
    );
    const cellGroups = cellGroupsRes.rows || [];
    const cellMap = new Map<string, string>();
    for (const c of cellGroups) {
      if (c.name) {
        cellMap.set(c.name.trim().toLowerCase(), c.id);
      }
      cellMap.set(c.id, c.id);
    }

    const results = {
      total: rawMembers.length,
      created: 0,
      updated: 0,
      errors: [] as { email: string; name: string; error: string }[]
    };

    for (const item of rawMembers) {
      const email = String(item.email || '').trim().toLowerCase();
      const name = String(item.name || '').trim();

      if (!email || !name) {
        results.errors.push({ email, name, error: "Nome e e-mail são obrigatórios" });
        continue;
      }

      // Prevenção de escalonamento de privilégio
      let roleValue = item.role || 'Membro';
      const isMasterRole = ['SUPERADMIN', 'SUPER_ADMIN', 'MASTER_ADMIN', 'MASTER', 'ADMIN_MASTER'].includes(String(roleValue).toUpperCase());
      if (isMasterRole && !auth.user.isSuperAdmin) {
        roleValue = 'Membro';
      }

      // Resolução da Célula
      let resolvedCellId: string | null = null;
      if (item.cell_id && cellMap.has(item.cell_id)) {
        resolvedCellId = cellMap.get(item.cell_id)!;
      } else if (item.cell_name) {
        const cKey = String(item.cell_name).trim().toLowerCase();
        if (cellMap.has(cKey)) {
          resolvedCellId = cellMap.get(cKey)!;
        }
      }

      // Normalização de Data de Nascimento (suporta DD/MM/AAAA ou AAAA-MM-DD)
      let normBirthDate: string | null = null;
      if (item.birth_date) {
        const rawDate = String(item.birth_date).trim();
        if (rawDate.includes('/')) {
          const parts = rawDate.split('/');
          if (parts.length === 3) {
            normBirthDate = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
          }
        } else if (rawDate.length === 10) {
          normBirthDate = rawDate;
        }
      }

      const pStreet = item.address_street || null;
      const pNumber = item.address_number || null;
      const pComplement = item.address_complement || null;
      const pNeighborhood = item.address_neighborhood || null;
      const pCity = item.address_city || null;
      const pState = item.address_state || null;
      const pZip = item.address_zip || null;
      const pAddressFull = pStreet 
        ? `${pStreet}, ${pNumber || 'S/N'}${pComplement ? ` - ${pComplement}` : ''} - ${pNeighborhood || ''}, ${pCity || ''} - ${pState || ''}` 
        : null;

      let cognitoUserId: string | null = null;
      let isNewCognitoUser = false;

      // 1. Tenta criar usuário no Cognito com TemporaryPassword
      try {
        const createCmd = new AdminCreateUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: email,
          TemporaryPassword: defaultPassword,
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "name", Value: name },
            { Name: "email_verified", Value: "true" }
          ],
          MessageAction: "SUPPRESS" // Não envia e-mails automáticos na importação em lote
        });
        const cognitoRes = await cognitoClient.send(createCmd);
        cognitoUserId = cognitoRes.User?.Username || uuidv4();
        isNewCognitoUser = true;
      } catch (cogErr: any) {
        if (cogErr.name === 'UsernameExistsException') {
          // Usuário já existe no Cognito: busca ID para vincular no banco
          try {
            const getCmd = new AdminGetUserCommand({
              UserPoolId: USER_POOL_ID,
              Username: email
            });
            const existingUser = await cognitoClient.send(getCmd);
            cognitoUserId = existingUser.Username || email;
          } catch {
            cognitoUserId = email;
          }
        } else {
          results.errors.push({ email, name, error: cogErr.message || "Erro no Cognito" });
          continue;
        }
      }

      // 2. Insere ou Atualiza no MySQL
      try {
        const checkSql = `SELECT id FROM members WHERE email = ? AND organization_id = ? LIMIT 1`;
        const checkRes = await query(checkSql, [email, orgValue]);

        if (checkRes.rows.length === 0) {
          const insertSql = `
            INSERT INTO members (
              id, name, email, phone, birth_date, role, status,
              cell_group_id, address_street, address_number, address_complement, 
              address_neighborhood, address_city, address_state, address_zip, address,
              organization_id, campus_id, campus_ids, invited_by
            )
            VALUES (?, ?, ?, ?, ?, ?, 'Ativo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `;
          await query(insertSql, [
            cognitoUserId || uuidv4(),
            name,
            email,
            item.phone || null,
            normBirthDate,
            roleValue,
            resolvedCellId,
            pStreet,
            pNumber,
            pComplement,
            pNeighborhood,
            pCity,
            pState,
            pZip,
            pAddressFull,
            orgValue,
            primaryCampus,
            campusIdsJson,
            auth.user.email
          ]);
          results.created++;
        } else {
          const existingId = checkRes.rows[0].id;
          const updateSql = `
            UPDATE members SET
              name = COALESCE(?, name),
              phone = COALESCE(?, phone),
              birth_date = COALESCE(?, birth_date),
              role = COALESCE(?, role),
              cell_group_id = COALESCE(?, cell_group_id),
              address_street = COALESCE(?, address_street),
              address_number = COALESCE(?, address_number),
              address_complement = COALESCE(?, address_complement),
              address_neighborhood = COALESCE(?, address_neighborhood),
              address_city = COALESCE(?, address_city),
              address_state = COALESCE(?, address_state),
              address_zip = COALESCE(?, address_zip),
              address = COALESCE(?, address),
              updated_at = NOW()
            WHERE id = ? AND organization_id = ?
          `;
          await query(updateSql, [
            name,
            item.phone || null,
            normBirthDate,
            roleValue,
            resolvedCellId,
            pStreet,
            pNumber,
            pComplement,
            pNeighborhood,
            pCity,
            pState,
            pZip,
            pAddressFull,
            existingId,
            orgValue
          ]);
          results.updated++;
        }
      } catch (dbErr: any) {
        results.errors.push({ email, name, error: dbErr.message || "Erro no banco de dados" });
      }
    }

    await logSecurityEvent({
      organizationId: orgValue,
      user: auth.user,
      action: 'BATCH_IMPORT_MEMBERS',
      resource: 'members',
      details: {
        total: results.total,
        created: results.created,
        updated: results.updated,
        errorsCount: results.errors.length
      },
      event: event as any
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: `Importação processada: ${results.created} criados, ${results.updated} atualizados.`,
        ...results
      })
    };
  } catch (error: any) {
    console.error("Erro no batchImport:", error);
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ error: "Erro interno ao processar importação em lote" }) 
    };
  }
};

