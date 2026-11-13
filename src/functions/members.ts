import {memberStateWrite} from '../services/memberHistoryWrite';
import { importMemberRows } from '../services/memberCsvImport';
import { getVerifiedClaims } from '../services/tokenVerifier';
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
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser, normalizeRole } from "../services/authMiddleware";
import { logSecurityEvent } from "../services/auditLogService";
import { checkRateLimit } from "../services/rateLimiter";
import {recordInvitationMilestone} from '../services/intelligenceInvitation';
import {intelligenceScope,scopedWhere} from '../services/intelligenceScope';
import {safeIdentifier} from '../services/intelligenceModel';

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || "us-east-2" });
const USER_POOL_ID = process.env.USER_POOL_ID as string;

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS,POST,GET,PUT,DELETE",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token"
};

const LEADERSHIP_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER'];

async function trackedResend(username:string,organizationId:string,userId:string,event:any){
  try{
    await cognitoClient.send(new AdminCreateUserCommand({UserPoolId:USER_POOL_ID,Username:username,MessageAction:'RESEND',DesiredDeliveryMediums:['EMAIL']}));
    return recordInvitationMilestone(organizationId,userId,'RESEND','REQUESTED',event);
  }catch(error){await recordInvitationMilestone(organizationId,userId,'RESEND','FAILED',event);throw error;}
}

// 1. Convidar / Cadastrar Membro
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
      organization_id, campus_id, campus_ids,
      operational_permissions 
    } = body;

    const tenantCheck = enforceTenant(auth.user, organization_id);
    if (!tenantCheck.allowed) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Acesso negado: organização inválida" }) };
    }
    const orgValue = tenantCheck.effectiveOrgId;

    const requestedRole = normalizeRole(role || 'MEMBER');
    const rank = ['MEMBER', 'VOLUNTEER', 'LEADER', 'TREASURER', 'ADMIN', 'PASTOR', 'SUPERADMIN'];
    if (!rank.includes(requestedRole) || (!auth.user.isSuperAdmin && (requestedRole === 'SUPERADMIN' || rank.indexOf(requestedRole) > rank.indexOf(auth.user.role)))) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Sem permissão para conceder este papel' }) };
    }
    if (operational_permissions !== undefined && !auth.user.isSuperAdmin && !['PASTOR', 'ADMIN'].includes(auth.user.role)) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Sem permissão para alterar permissões operacionais' }) };
    }
    const campusList=[...new Set<string>(Array.isArray(campus_ids)&&campus_ids.length?campus_ids:campus_id?[campus_id]:['campus_sede'])];
    if(!campusList.length||campusList.length>100||campusList.some(id=>!safeIdentifier(id)||id==='all'))return {statusCode:400,headers,body:JSON.stringify({error:'Selecione unidades específicas para o convite.'})};
    if(!auth.user.isSuperAdmin&&!auth.user.campusIds.includes('all')&&campusList.some(id=>!auth.user.campusIds.includes(id)))return {statusCode:403,headers,body:JSON.stringify({error:'Sem permissão para conceder acesso a esta unidade.'})};
    const {rows:validCampuses}=await query(`SELECT id FROM campuses WHERE organization_id = ? AND id IN (${campusList.map(()=>'?').join(',')})`,[orgValue,...campusList]);
    if(validCampuses.length!==campusList.length)return {statusCode:400,headers,body:JSON.stringify({error:'Confira as unidades da igreja antes de enviar o convite.'})};
    const primaryCampus=campusList[0],campusIdsJson=JSON.stringify(campusList);
    const inviteScope=await intelligenceScope(event as any,auth.user,{organization_id:orgValue,campus_id:primaryCampus});
    if('statusCode'in inviteScope)return inviteScope;
    if(inviteScope.cellIds&&(!cellGroupId||!inviteScope.cellIds.includes(cellGroupId)))return {statusCode:403,headers,body:JSON.stringify({error:'Líderes podem convidar somente para seus grupos.'})};
    if(cellGroupId){const {rows:cells}=await query("SELECT id FROM cell_groups WHERE organization_id = ? AND COALESCE(campus_id,'campus_sede') = ? AND id = ?",[orgValue,primaryCampus,cellGroupId]);if(!cells.length)return {statusCode:400,headers,body:JSON.stringify({error:'A célula precisa pertencer à mesma igreja e unidade.'})};}
    const userAttributes: { Name: string; Value: string }[] = [
      { Name: "email", Value: email },
      { Name: "name", Value: name },
      { Name: "email_verified", Value: "true" }
    ];

    if (phone) {
      const cleanPhone = String(phone).replace(/\D/g, '');
      if (cleanPhone.length >= 10) {
        const e164 = String(phone).startsWith('+')
          ? String(phone)
          : (cleanPhone.startsWith('55') ? `+${cleanPhone}` : `+55${cleanPhone}`);
        userAttributes.push({ Name: "phone_number", Value: e164 });
        userAttributes.push({ Name: "phone_number_verified", Value: "true" });
      }
    }

    const command = new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      UserAttributes: userAttributes,
      DesiredDeliveryMediums: ["EMAIL"]
    });

    const response = await cognitoClient.send(command);
    const cognitoUserId = response.User?.Username || uuidv4();

    let roleValue = requestedRole;
    // Anti-Privilege Escalation: Apenas SuperAdmins podem atribuir papéis de administração Master
    const isMasterRole = ['SUPERADMIN', 'SUPER_ADMIN', 'MASTER_ADMIN', 'MASTER', 'ADMIN_MASTER'].includes(String(roleValue).toUpperCase());
    if (isMasterRole && !auth.user.isSuperAdmin) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Apenas Administradores Master podem conceder permissões globais" }) };
    }

    const pBirthDate = birth_date || birthDate || null;
    const pStreet = address_street || null;
    const pNumber = address_number || null;
    const pComplement = address_complement || null;
    const pNeighborhood = address_neighborhood || null;
    const pCity = address_city || null;
    const pState = address_state || null;
    const pZip = address_zip || null;
    const pAddressFull = address || (pStreet ? `${pStreet}, ${pNumber || 'S/N'}${pComplement ? ` - ${pComplement}` : ''} - ${pNeighborhood || ''}, ${pCity || ''} - ${pState || ''}` : null);
    const pOperational = operational_permissions !== undefined 
      ? (Array.isArray(operational_permissions) ? JSON.stringify(operational_permissions) : String(operational_permissions)) 
      : null;

    // MySQL Insert
    const insertQuery = `
      INSERT INTO members (
        id, name, email, role, status, cpf, baptism_date, cell_group_id, phone, invited_by, 
        birth_date, address_street, address_number, address_complement, address_neighborhood, address_city, address_state, address_zip, address,
        organization_id, campus_id, campus_ids, operational_permissions
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await memberStateWrite(insertQuery, [
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
      campusIdsJson,
      pOperational
    ], {organizationId:orgValue,user:auth.user,event,source:'INVITE',memberId:cognitoUserId});

    const registrationTracked=await recordInvitationMilestone(orgValue,cognitoUserId,'INVITE','REGISTERED',event);
    const invitationTracked=await recordInvitationMilestone(orgValue,cognitoUserId,'INVITE','REQUESTED',event);
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
      organization_id: orgValue, campus_id: primaryCampus, campus_ids: campusList,
      operational_permissions: pOperational 
    };

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({ message: "Membro convidado com sucesso", user: newUser,activation_tracking_pending:!registrationTracked||!invitationTracked }),
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

    const scope = enforceTenant(auth.user, event.headers?.['x-organization-id'] || event.queryStringParameters?.organization_id);
    if (!scope.allowed) return scope.errorResponse!;
    const { rows: memberRows } = await query(
      `SELECT id, organization_id, email, status, role, campus_id FROM members WHERE LOWER(TRIM(email)) = ? AND organization_id = ? LIMIT 1`,
      [cleanEmail, scope.effectiveOrgId]
    );

    if (memberRows.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Membro não encontrado no banco de dados" }) };
    }

    const statusScope=await intelligenceScope(event as any,auth.user);if('statusCode' in statusScope)return statusScope;
    if(statusScope.campusIds&&!statusScope.campusIds.includes(memberRows[0].campus_id||'campus_sede'))return {statusCode:403,headers,body:JSON.stringify({error:'Perfil fora das suas unidades.'})};
    const targetRank=['MEMBER','VOLUNTEER','LEADER','TREASURER','ADMIN','PASTOR','SUPERADMIN'];
    if(!auth.user.isSuperAdmin&&targetRank.indexOf(normalizeRole(memberRows[0].role))>targetRank.indexOf(auth.user.role))return {statusCode:403,headers,body:JSON.stringify({error:'Sem permissão para alterar este perfil.'})};
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
    const updateQuery = `UPDATE members SET status = ?, updated_at = NOW() WHERE LOWER(TRIM(email)) = ? AND organization_id = ?`;
    await memberStateWrite(updateQuery, [statusValue, cleanEmail, scope.effectiveOrgId], {organizationId:scope.effectiveOrgId,user:auth.user,event,source:'STATUS'});

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
    const rateLimit = await checkRateLimit(event as any, {
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

    const tenantCheck = enforceTenant(auth.user, event.headers?.['x-organization-id'] || event.queryStringParameters?.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const invitationScope=await intelligenceScope(event as any,auth.user);if('statusCode'in invitationScope)return invitationScope;
    const invitationFilter=scopedWhere(invitationScope,'m','campus_id','cell_group_id');
    const { rows: targets } = await query(`SELECT m.id,m.role FROM members m WHERE LOWER(m.email) = ? AND m.organization_id = ?${invitationFilter.sql}`, [cleanEmail, tenantCheck.effectiveOrgId,...invitationFilter.params]);
    if (!targets.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Membro não encontrado' }) };
    if (normalizeRole(targets[0].role) === 'SUPERADMIN' && !auth.user.isSuperAdmin) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Acesso negado' }) };
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
      const tracked=await trackedResend(cleanEmail,tenantCheck.effectiveOrgId,targets[0].id,event);
      return { 
        statusCode: 200, 
        headers, 
        body: JSON.stringify({ message: "Reenvio do convite e senha provisória solicitado ao AWS Cognito.",activation_tracking_pending:!tracked })
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
        const tracked=await trackedResend(cleanEmail,tenantCheck.effectiveOrgId,targets[0].id,event);
        return { 
          statusCode: 200, 
          headers, 
          body: JSON.stringify({ message: "Reenvio do convite de ativação solicitado ao AWS Cognito.",activation_tracking_pending:!tracked })
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

    const roleCheck = enforceRole(auth.user, LEADERSHIP_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;
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

    const tenantCheck = enforceTenant(auth.user, event.headers?.['x-organization-id'] || event.queryStringParameters?.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    if (!['me', 'user_me', auth.user.userId].includes(rawId)) {
      const roleCheck = enforceRole(auth.user, LEADERSHIP_ROLES);
      if (!roleCheck.allowed) return roleCheck.errorResponse!;
    }
    const getQuery = `
      SELECT m.*, cg.name as cell_group_name 
      FROM members m 
      LEFT JOIN cell_groups cg ON m.cell_group_id = cg.id 
      WHERE m.organization_id = ? AND ((m.id = ? AND m.id != '') OR (m.email IS NOT NULL AND LOWER(m.email) = LOWER(?)))
      LIMIT 1;
    `;
    const dbResult = await query(getQuery, [tenantCheck.effectiveOrgId, effectiveId, effectiveEmail || effectiveId]);

    if (dbResult.rows.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ message: "Membro não encontrado" }) };
    }

    const memberData = dbResult.rows[0];
    const isSelf = rawId === 'me' || rawId === 'user_me' || auth.user.userId === memberData.id || (auth.user.email && auth.user.email.toLowerCase() === (memberData.email || '').toLowerCase());

    if (!isSelf) {
      const tenantCheck = enforceTenant(auth.user, memberData.organization_id);
      if (!tenantCheck.allowed) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: "Acesso negado" }) };
      }
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

    const rawId = event.pathParameters?.id;
    if (!rawId) throw new Error("Missing member ID");

    const effectiveId = (rawId === 'me' || rawId === 'user_me') ? auth.user.userId : rawId;
    const effectiveEmail = (rawId === 'me' || rawId === 'user_me') ? (auth.user.email || '') : '';

    const scope = enforceTenant(auth.user, event.headers?.['x-organization-id'] || event.queryStringParameters?.organization_id);
    if (!scope.allowed) return scope.errorResponse!;
    let { rows: existingRows } = await query(
      `SELECT id, organization_id, email, role, campus_id, campus_ids, cell_group_id FROM members WHERE organization_id = ? AND ((id = ? AND id != '') OR (email IS NOT NULL AND LOWER(email) = LOWER(?))) LIMIT 1`,
      [scope.effectiveOrgId, effectiveId, effectiveEmail || effectiveId]
    );

    if (!existingRows.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Membro não encontrado' }) };

    const targetMemberId = existingRows[0].id;
    const targetRole = normalizeRole(existingRows[0].role);
    const ranks = ['MEMBER', 'VOLUNTEER', 'LEADER', 'TREASURER', 'ADMIN', 'PASTOR', 'SUPERADMIN'];
    if (!auth.user.isSuperAdmin && ranks.indexOf(targetRole) > ranks.indexOf(auth.user.role)) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Sem permissão para alterar este perfil' }) };
    const isSelf = rawId === 'me' || rawId === 'user_me' || auth.user.userId === targetMemberId || (auth.user.email && auth.user.email.toLowerCase() === (existingRows[0].email || '').toLowerCase());
    const isLeadership = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER'].includes(auth.user.role);

    if (!isSelf && !isLeadership) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Permissão insuficiente para alterar outro perfil" }) };
    }

    if (!isSelf) {
      const tenantCheck = enforceTenant(auth.user, existingRows[0].organization_id);
      if (!tenantCheck.allowed) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: "Acesso negado" }) };
      }
    }

    const body = JSON.parse(event.body || '{}');
    const { 
      name, cpf, baptismDate, cellGroupId, role, phone, address, avatar_url, campus_id, campus_ids,
      birth_date, birthDate,
      address_street, address_number, address_complement, address_neighborhood, address_city, address_state, address_zip,
      operational_permissions
    } = body;

    const requestedRole = normalizeRole(role || 'MEMBER');
    const rank = ['MEMBER', 'VOLUNTEER', 'LEADER', 'TREASURER', 'ADMIN', 'PASTOR', 'SUPERADMIN'];
    if (!rank.includes(requestedRole) || (!auth.user.isSuperAdmin && (requestedRole === 'SUPERADMIN' || rank.indexOf(requestedRole) > rank.indexOf(auth.user.role)))) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Sem permissão para conceder este papel' }) };
    }
    if (operational_permissions !== undefined && !auth.user.isSuperAdmin && !['PASTOR', 'ADMIN'].includes(auth.user.role)) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Sem permissão para alterar permissões operacionais' }) };
    }
    if ((campus_id !== undefined || campus_ids !== undefined) && !isLeadership) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Somente liderança pode alterar unidades' }) };
    if (role !== undefined && !isLeadership) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Sem permissão para alterar papéis' }) };
    // Membro regular não pode alterar o próprio papel (Role escalation prevention)
    const isEscalatingToMaster = ['SUPERADMIN', 'SUPER_ADMIN', 'MASTER_ADMIN', 'MASTER', 'ADMIN_MASTER'].includes(String(role || '').toUpperCase());
    if (role && isEscalatingToMaster && !auth.user.isSuperAdmin) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Apenas SuperAdmins podem conceder permissão Master" }) };
    }
    const current = existingRows[0];
    const profileScope = await intelligenceScope(event as any, auth.user);
    if ('statusCode' in profileScope) return profileScope;
    const currentCampus = current.campus_id || 'campus_sede';
    if (!isSelf && profileScope.campusIds && !profileScope.campusIds.includes(currentCampus)) return {statusCode:403,headers,body:JSON.stringify({error:'Perfil fora das suas unidades.'})};
    if (!isSelf && profileScope.cellIds && !profileScope.cellIds.includes(current.cell_group_id)) return {statusCode:403,headers,body:JSON.stringify({error:'Perfil fora dos seus grupos.'})};
    const primary = campus_id === undefined ? currentCampus : campus_id;
    if (campus_id !== undefined || campus_ids !== undefined) {
      const ids = campus_ids === undefined ? [primary] : campus_ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !safeIdentifier(primary) || !ids.includes(primary) && !ids.includes('all')) return {statusCode:400,headers,body:JSON.stringify({error:'Confira a unidade principal e os acessos.'})};
      if (ids.some((id:any)=>!safeIdentifier(id)) || ids.includes('all') && !auth.user.isSuperAdmin && !auth.user.campusIds.includes('all')) return {statusCode:403,headers,body:JSON.stringify({error:'Sem permissão para conceder este acesso.'})};
      const specific = [...new Set([primary,...ids.filter((id:string)=>id!=='all')])];
      if (profileScope.campusIds && specific.some(id=>!profileScope.campusIds!.includes(id))) return {statusCode:403,headers,body:JSON.stringify({error:'Unidade fora do seu acesso.'})};
      const {rows:valid} = await query(`SELECT id FROM campuses WHERE organization_id = ? AND id IN (${specific.map(()=>'?').join(',')})`,[scope.effectiveOrgId,...specific]);
      if (valid.length!==specific.length) return {statusCode:400,headers,body:JSON.stringify({error:'Unidade não encontrada nesta igreja.'})};
    }
    const nextCell = cellGroupId === undefined ? current.cell_group_id : cellGroupId;
    if (cellGroupId !== undefined && nextCell !== current.cell_group_id && !isLeadership) return {statusCode:403,headers,body:JSON.stringify({error:'A liderança aprova o vínculo de célula.'})};
    if (nextCell && (cellGroupId !== undefined || campus_id !== undefined)) {
      const {rows:cells} = await query("SELECT id,leader_id FROM cell_groups WHERE organization_id = ? AND id = ? AND COALESCE(campus_id,'campus_sede') = ?",[scope.effectiveOrgId,nextCell,primary]);
      if (!cells.length || profileScope.cellIds && !profileScope.cellIds.includes(nextCell)) return {statusCode:400,headers,body:JSON.stringify({error:'Selecione uma célula da mesma unidade dentro do seu acesso, ou remova o vínculo.'})};
    }
    const pRole = isLeadership && role !== undefined ? requestedRole : null;

    const pName = name !== undefined ? name : null;
    const pCpf = cpf !== undefined ? cpf : null;
    const pBaptism = baptismDate !== undefined ? baptismDate : null;
    const pCell = cellGroupId !== undefined ? cellGroupId : null;
    const pPhone = phone !== undefined ? phone : null;
    const pAddress = address !== undefined ? address : null;
    const pAvatar = avatar_url !== undefined ? avatar_url : null;
    const pCampus = campus_id !== undefined ? campus_id : null;
    const pCampusIds = campus_ids !== undefined ? JSON.stringify(campus_ids) : campus_id !== undefined && campus_id !== currentCampus ? JSON.stringify([primary]) : null;

    const pBirthDate = birth_date !== undefined ? birth_date : (birthDate !== undefined ? birthDate : null);
    const pStreet = address_street !== undefined ? address_street : null;
    const pNumber = address_number !== undefined ? address_number : null;
    const pComplement = address_complement !== undefined ? address_complement : null;
    const pNeighborhood = address_neighborhood !== undefined ? address_neighborhood : null;
    const pCity = address_city !== undefined ? address_city : null;
    const pState = address_state !== undefined ? address_state : null;
    const pZip = address_zip !== undefined ? address_zip : null;
    const pOperational = operational_permissions !== undefined 
      ? (Array.isArray(operational_permissions) ? JSON.stringify(operational_permissions) : String(operational_permissions)) 
      : null;

    const updateQuery = `
      UPDATE members 
      SET 
        name = COALESCE(?, name),
        cpf = COALESCE(?, cpf),
        baptism_date = COALESCE(?, baptism_date),
        cell_group_id = IF(?, ?, cell_group_id),
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
        operational_permissions = COALESCE(?, operational_permissions),
        updated_at = NOW()
      WHERE id = ? AND organization_id = ?
    `;

    await memberStateWrite(updateQuery, [
      pName, pCpf, pBaptism, cellGroupId !== undefined, pCell || null, pRole, pPhone, pAddress, pAvatar, pCampus, pCampusIds,
      pBirthDate, pStreet, pNumber, pComplement, pNeighborhood, pCity, pState, pZip,
      pOperational,
      targetMemberId, scope.effectiveOrgId
    ], {organizationId:scope.effectiveOrgId,user:auth.user,event,source:'PROFILE',memberId:targetMemberId});

    await logSecurityEvent({
      organizationId: existingRows[0].organization_id,
      user: auth.user,
      action: 'UPDATE_MEMBER_PROFILE',
      resource: 'members',
      resourceId: targetMemberId,
      event: event as any
    });

    return { statusCode: 200, headers, body: JSON.stringify({ message: "Perfil atualizado", id: targetMemberId }) };
  } catch (error: any) {
    console.error('Erro ao atualizar membro:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Erro ao atualizar membro" }) };
  }
};

// 7. Solicitar Participação em Célula (App Mobile & PWA)
export const requestCell: APIGatewayProxyHandlerV2 = async (event) => {
  const auth = await requireAuth(event as any);
  if ('errorResponse' in auth) return auth.errorResponse;
  const tenantCheck = enforceTenant(auth.user, event.headers?.['x-organization-id']);
  if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
  const pathId = event.pathParameters?.id;
  if (pathId && !['me', 'user_me', auth.user.userId].includes(pathId)) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Solicitação permitida apenas para o próprio perfil' }) };
  const { cellGroupId } = JSON.parse(event.body || '{}');
  const { rows } = await query('SELECT id FROM cell_groups WHERE id = ? AND organization_id = ?', [cellGroupId, tenantCheck.effectiveOrgId]);
  if (!rows.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Célula não encontrada' }) };
  await query('UPDATE members SET pending_cell_group_id = ?, updated_at = NOW() WHERE id = ? AND organization_id = ?', [cellGroupId, auth.user.userId, tenantCheck.effectiveOrgId]);
  return { statusCode: 200, headers, body: JSON.stringify({ member_id: auth.user.userId, cell_group_id: cellGroupId }) };
};

export const selfRegister: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const rateLimit = await checkRateLimit(event as any, {
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

    const claims = await getVerifiedClaims(event as any);
    if (!claims?.sub || !claims.email || ![true, 'true'].includes(claims.email_verified as any)) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Autenticação com e-mail verificado obrigatória' }) };
    if (!event.body) throw new Error('Missing request body');
    const {
      name, phone, birthdate, birth_date, birthDate, address,
      address_street, address_number, address_complement, address_neighborhood, address_city, address_state, address_zip,
      organization_id, campus_id, avatar_url 
    } = JSON.parse(event.body);

    const email = String(claims.email).toLowerCase().trim();
    const memberId = claims.sub;
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
    const pAvatar = avatar_url || null;

    const checkSql = `SELECT id, organization_id, status FROM members WHERE id = ? OR LOWER(email) = LOWER(?) LIMIT 2`;
    const checkRes = await query(checkSql, [memberId, email]);

    if (checkRes.rows.length > 1) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Identidade ambígua' }) };
    const existing = checkRes.rows[0];
    if (existing && (existing.organization_id !== orgValue || ['INACTIVE', 'INATIVO', 'BLOCKED', 'DISABLED'].includes(String(existing.status).toUpperCase()))) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Cadastro indisponível nesta organização' }) };
    const { rows: orgs } = await query('SELECT id FROM organizations WHERE id = ?', [orgValue]);
    if (!orgs.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Organização não encontrada' }) };
    if (checkRes.rows.length === 0) {
      const insertSql = `
        INSERT INTO members (
          id, name, email, phone, birth_date, 
          address_street, address_number, address_complement, address_neighborhood, address_city, address_state, address_zip, address,
          avatar_url, role, status, organization_id, campus_id, campus_ids
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Membro', 'Ativo', ?, ?, ?)
      `;
      await memberStateWrite(insertSql, [
        memberId, memberName, email, phone || null, effectiveBirthDate,
        pStreet, pNumber, pComplement, pNeighborhood, pCity, pState, pZip, pAddressFull,
        pAvatar, orgValue, primaryCampus, campusIdsJson
      ], {organizationId:orgValue,actorId:memberId,event,source:'SELF_REGISTER',memberId});
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
          avatar_url = COALESCE(?, avatar_url),
          updated_at = NOW()
        WHERE id = ? AND organization_id = ?
      `;
      await memberStateWrite(updateSql, [
        name || null, phone || null, effectiveBirthDate,
        pStreet, pNumber, pComplement, pNeighborhood, pCity, pState, pZip, pAddressFull,
        pAvatar,
        existingId, orgValue
      ], {organizationId:orgValue,actorId:memberId,event,source:'SELF_REGISTER',memberId});
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ message: "Membro sincronizado com sucesso", id: checkRes.rows[0]?.id || memberId })
    };
  } catch (error: any) {
    console.error("Erro no selfRegister:", error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Erro ao sincronizar membro" }) };
  }
};

// 12. CSV import: tenant validation precedes every row and invitation.
export const batchImport: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const auth = await requireAuth(event as any);
    if ('errorResponse' in auth) return auth.errorResponse;
    const role = enforceRole(auth.user, LEADERSHIP_ROLES);
    if (!role.allowed) return role.errorResponse!;
    const body = JSON.parse(event.body || '{}');
    const tenant = enforceTenant(auth.user, body.organization_id);
    if (!tenant.allowed) return tenant.errorResponse!;
    const headerOrg = event.headers?.['x-organization-id'] || event.headers?.['X-Organization-Id'];
    if (headerOrg && headerOrg !== tenant.effectiveOrgId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Organizações conflitantes na requisição.' }) };
    const results = await importMemberRows(body, auth.user, tenant.effectiveOrgId, cognitoClient, USER_POOL_ID, event);
    return { statusCode: 200, headers, body: JSON.stringify({ message: 'Importação processada.', ...results }) };
  } catch (error: any) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: error instanceof SyntaxError ? 'JSON inválido.' : error.message || 'Não foi possível processar a importação.' }) };
  }
};
