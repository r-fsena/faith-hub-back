import { getMySchedules, respondRosterItem, getMyBlockouts, createBlockout, deleteBlockout, getEligiblePeersForSwap, requestRosterSwap, getMyPendingSwaps, respondToSwap, cancelRosterSwap, applyToMinistry } from './volunteerPersonal';
export { getMySchedules, respondRosterItem, getMyBlockouts, createBlockout, deleteBlockout, getEligiblePeersForSwap, requestRosterSwap, getMyPendingSwaps, respondToSwap, cancelRosterSwap, applyToMinistry };
import { requireMinistryAuth, MinistryScope, MinistryScopeError, scopedMinistry, volunteerMember, isMinistryParticipant, campusFilter, assertCampus, ministryFailure } from '../services/ministryScope';
import { enforcePlanAccess } from '../services/planAccess';
import { authorizeResource } from '../services/tenantResource';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';
import { enforceRole, enforceTenant } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';

const MINISTRY_ADMIN_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'TREASURER', 'LEADER'];
const MINISTRY_VIEW_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'TREASURER', 'LEADER', 'VOLUNTEER', 'MEMBER'];
const GLOBAL_MINISTRY_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN'];

/**
 * Checks if user has permission to manage a specific ministry:
 * - SuperAdmin, Pastor and Admin have global permission across all ministries
 * - Other eligible roles only have permission if they are the designated leader_id
 */
export function canUserManageMinistry(user: any, ministry: { leader_id?: string | null }): boolean {
  if (user.isSuperAdmin || GLOBAL_MINISTRY_ROLES.includes(user.role)) {
    return true;
  }
  return Boolean(
    ministry.leader_id &&
    (ministry.leader_id === user.userId || (user.email && ministry.leader_id.toLowerCase() === user.email.toLowerCase()))
  );
}

async function canUserViewMinistrySchedules(scope: MinistryScope, ministry: any, memberOnly = false): Promise<boolean> {
  if (!memberOnly && canUserManageMinistry(scope.user, ministry)) return true;
  return isMinistryParticipant(scope, ministry, await volunteerMember(scope));
}

async function validateRoster(scope: MinistryScope, ministry: any, items: any[]) {
  if (!Array.isArray(items)) throw new MinistryScopeError(apiResponse(400, { error: 'INVALID_ROSTER_ITEMS' }));
  for (const item of items) {
    if (!item.member_id || !item.role_id) continue;
    const { rows } = await query(`SELECT mem.id FROM members mem
      JOIN ministry_roles mr ON mr.organization_id = mem.organization_id AND mr.id = ? AND mr.ministry_id = ?
      WHERE mem.organization_id = ? AND mem.id = ? AND mem.status NOT IN ('INACTIVE','INATIVO','DISABLED','BLOCKED')
      AND (EXISTS (SELECT 1 FROM ministry_volunteers mv WHERE mv.organization_id = mem.organization_id AND mv.ministry_id = mr.ministry_id AND mv.member_id = mem.id AND mv.status IN ('ACTIVE','TRAINING')) OR ? = mem.id OR (? <> '' AND LOWER(?) = LOWER(mem.email))) LIMIT 1`, [item.role_id, ministry.id, scope.organizationId, item.member_id, ministry.leader_id || '', ministry.leader_id || '', ministry.leader_id || '']);
    if (!rows.length) throw new MinistryScopeError(apiResponse(403, { error: 'VOLUNTEER_NOT_LINKED_TO_MINISTRY', message: 'O voluntário e a função precisam pertencer a este ministério, nesta igreja e unidade.' }));
  }
}

// GET /ministries -> Listar Ministérios com contadores de voluntários e funções
export const listMinistries = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'ministries.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireMinistryAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;
    const roleCheck = enforceRole(auth.user, MINISTRY_VIEW_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const user = auth.user;
    const requestedOrgId = auth.organizationId;
        const statusParam = event.queryStringParameters?.scope === 'member' ? 'ACTIVE' : event.queryStringParameters?.status; // 'ACTIVE', 'INACTIVE' or 'all'
    const managementScope = event.queryStringParameters?.scope === 'manage';

    const tenantScope = enforceTenant(user, requestedOrgId);
    if (!tenantScope.allowed) return tenantScope.errorResponse!;
    const orgId = tenantScope.effectiveOrgId;

    let volunteerSelect = `
        NULL as my_volunteer_status,
        NULL as my_volunteer_roles,
        NULL as my_volunteer_joined_at,
    `;
    const ownMember = await volunteerMember(auth);
    const params: any[] = [ownMember?.id || '', ownMember?.email || '', ownMember?.email?.toLowerCase() || ''];
    if (ownMember) {
      volunteerSelect = `
        (SELECT mv.status FROM ministry_volunteers mv WHERE mv.organization_id = m.organization_id AND mv.ministry_id = m.id AND mv.member_id = ? LIMIT 1) as my_volunteer_status,
        (SELECT mv.roles_csv FROM ministry_volunteers mv WHERE mv.organization_id = m.organization_id AND mv.ministry_id = m.id AND mv.member_id = ? LIMIT 1) as my_volunteer_roles,
        (SELECT mv.joined_at FROM ministry_volunteers mv WHERE mv.organization_id = m.organization_id AND mv.ministry_id = m.id AND mv.member_id = ? LIMIT 1) as my_volunteer_joined_at,
      `;
      params.push(ownMember.id, ownMember.id, ownMember.id);
    }

    let sql = `
      SELECT 
        m.*,
        (m.leader_id = ? OR (? <> '' AND LOWER(m.leader_id) = ?)) AS my_is_leader,
        ${volunteerSelect}
        (SELECT COUNT(*) FROM ministry_roles mr WHERE mr.ministry_id = m.id AND mr.organization_id = m.organization_id) as roles_count,
        (SELECT COUNT(*) FROM ministry_volunteers mvc WHERE mvc.ministry_id = m.id AND mvc.organization_id = m.organization_id AND mvc.status = 'ACTIVE') as volunteers_count,
        (SELECT COUNT(*) FROM service_schedules ssc WHERE ssc.ministry_id = m.id AND ssc.organization_id = m.organization_id AND ssc.service_date >= CURDATE()) as upcoming_schedules_count
      FROM ministries m
      WHERE m.organization_id = ?
    `;

    params.push(orgId);

    if (managementScope && !(user.isSuperAdmin || GLOBAL_MINISTRY_ROLES.includes(user.role))) {
      sql += ` AND m.leader_id = ?`;
      params.push(user.userId);
    }

    if (statusParam && statusParam !== 'all') {
      sql += ` AND m.status = ?`;
      params.push(statusParam);
    }

    const ministryCampus = campusFilter(auth, 'm');
    sql += ministryCampus.sql; params.push(...ministryCampus.params);
    sql += ` ORDER BY m.name ASC`;

    const { rows } = await query(sql, params);
    return apiResponse(200, rows);
  } catch (err: any) {
    return ministryFailure(err);
  }
};

// POST /ministries -> Criar ou Atualizar Ministério
export const createOrUpdateMinistry = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'ministries.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireMinistryAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const { 
      id, 
      name, 
      slug, 
      description, 
      image_url,
      icon = 'Users', 
      color = '#0f766e', 
      leader_id, 
      leader_name, 
      status = 'ACTIVE', 
      campus_id,
      organization_id 
    } = body;

    const tenantCheck = enforceTenant(auth.user, organization_id || auth.organizationId);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    if (!name) return apiResponse(400, { error: 'Nome do ministério é obrigatório' });
    let effectiveCampusId = campus_id || auth.campusId;
    if (!effectiveCampusId && id) effectiveCampusId = (await scopedMinistry(auth, id)).campus_id;
    if (!effectiveCampusId || effectiveCampusId === 'all') return apiResponse(400, { message: 'Selecione a unidade à qual o ministério pertence.' });
    const { rows: targetCampus } = await query('SELECT id FROM campuses WHERE organization_id = ? AND id = ? LIMIT 1', [auth.organizationId, effectiveCampusId]);
    if (!targetCampus.length) return apiResponse(404, { error: 'CAMPUS_NOT_FOUND_IN_ORGANIZATION' });


    if (id) {
      const resource = await authorizeResource({ ...event, headers: { ...event.headers, 'x-organization-id': tenantCheck.effectiveOrgId } }, 'ministries', id, MINISTRY_ADMIN_ROLES);
      if ('errorResponse' in resource) return resource.errorResponse;
    }
    const isGlobal = auth.user.isSuperAdmin || GLOBAL_MINISTRY_ROLES.includes(auth.user.role);

    // Apenas Pastores e Administradores Globais podem criar novos ministérios
    if (!id && !isGlobal) {
      return apiResponse(403, { error: 'Apenas Administradores e Pastores podem criar novos ministérios.' });
    }

    // Se estiver editando, validar permissão de escopo
    if (id && !isGlobal) {
      const { rows: existingRows } = await query(`SELECT leader_id FROM ministries WHERE id = ? AND organization_id = ? LIMIT 1`, [id, auth.organizationId]);
      if (existingRows.length === 0) return apiResponse(404, { error: 'Ministério não encontrado' });
      if (!canUserManageMinistry(auth.user, existingRows[0])) {
        return apiResponse(403, { error: 'Acesso negado: Você só pode editar o ministério pelo qual é responsável.' });
      }
    }

    // Resolver nome do líder caso tenha sido passado apenas o leader_id
    let finalLeaderName = leader_name;
    if (leader_id && (!finalLeaderName || finalLeaderName === '')) {
      const { rows: memRows } = await query(`SELECT name FROM members WHERE id = ? AND organization_id = ? LIMIT 1`, [leader_id, auth.organizationId]);
      if (memRows.length > 0) {
        finalLeaderName = memRows[0].name;
      }
    }

    const finalId = id || uuidv4();
    const finalSlug = slug || name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');

    const q = `
      INSERT INTO ministries (id, organization_id, campus_id, name, slug, description, image_url, icon, color, leader_id, leader_name, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        slug = VALUES(slug),
        description = VALUES(description),
        image_url = VALUES(image_url),
        icon = VALUES(icon),
        color = VALUES(color),
        leader_id = VALUES(leader_id),
        leader_name = VALUES(leader_name),
        status = VALUES(status),
        campus_id = VALUES(campus_id),
        updated_at = NOW()
    `;

    await query(q, [
      finalId,
      tenantCheck.effectiveOrgId,
      effectiveCampusId,
      name,
      finalSlug,
      description || null,
      image_url || null,
      icon,
      color,
      leader_id || null,
      finalLeaderName || null,
      status
    ]);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: id ? 'UPDATE_MINISTRY' : 'CREATE_MINISTRY',
      resource: 'ministries',
      resourceId: finalId,
      details: { name, slug: finalSlug, status, leader_id },
      event
    });

    return apiResponse(id ? 200 : 201, { message: 'Ministério salvo com sucesso', id: finalId });
  } catch (err: any) {
    return ministryFailure(err);
  }
};

// DELETE /ministries/{id}
export const deleteMinistry = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'ministries.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireMinistryAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN']);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID faltante' });

    const { rows } = await query(`SELECT organization_id, name FROM ministries WHERE id = ? AND organization_id = ? LIMIT 1`, [id, auth.organizationId]);
    if (rows.length === 0) return apiResponse(404, { message: 'Ministério não encontrado' });

    const tenantCheck = enforceTenant(auth.user, rows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    await scopedMinistry(auth, id);
    await query(`DELETE FROM ministries WHERE id = ? AND organization_id = ?`, [id, auth.organizationId]);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'DELETE_MINISTRY',
      resource: 'ministries',
      resourceId: id,
      details: { name: rows[0].name },
      event
    });

    return apiResponse(200, { message: 'Ministério excluído com sucesso' });
  } catch (err: any) {
    return ministryFailure(err);
  }
};

// GET /ministries/{id}/roles -> Listar funções do ministério
export const listMinistryRoles = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'ministries.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireMinistryAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;
    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério ausente' });
    await scopedMinistry(auth, ministryId);

    const { rows: ministryRows } = await query(
      `SELECT id, organization_id, campus_id, leader_id FROM ministries WHERE id = ? AND organization_id = ? LIMIT 1`,
      [ministryId, auth.organizationId]
    );
    if (ministryRows.length === 0) return apiResponse(404, { error: 'Ministério não encontrado' });
    const ministry = ministryRows[0];
    const tenantCheck = enforceTenant(auth.user, ministry.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    if (!canUserManageMinistry(auth.user, ministry)) {
      return apiResponse(403, { error: 'Acesso negado: funções disponíveis apenas para o responsável pelo ministério.' });
    }

    const { rows } = await query(
      `SELECT * FROM ministry_roles WHERE ministry_id = ? AND organization_id = ? ORDER BY name ASC`,
      [ministryId, tenantCheck.effectiveOrgId]
    );
    return apiResponse(200, rows);
  } catch (err: any) {
    return ministryFailure(err);
  }
};

// POST /ministries/{id}/roles -> Criar função no ministério
export const createMinistryRole = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'ministries.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireMinistryAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério ausente' });
    await scopedMinistry(auth, ministryId);

    const { rows: minRows } = await query(`SELECT organization_id, leader_id FROM ministries WHERE id = ? AND organization_id = ? LIMIT 1`, [ministryId, auth.organizationId]);
    if (minRows.length === 0) return apiResponse(404, { error: 'Ministério não encontrado' });

    const tenantCheck = enforceTenant(auth.user, minRows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    if (!canUserManageMinistry(auth.user, minRows[0])) {
      return apiResponse(403, { error: 'Acesso negado: Você só pode gerenciar funções do ministério que lidera.' });
    }

    const body = JSON.parse(event.body || '{}');
    const { name, description, min_volunteers = 1 } = body;
    if (!name) return apiResponse(400, { error: 'Nome da função é obrigatório' });

    const roleId = uuidv4();
    await query(`
      INSERT INTO ministry_roles (id, organization_id, ministry_id, name, description, min_volunteers)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [roleId, tenantCheck.effectiveOrgId, ministryId, name, description || null, Number(min_volunteers) || 1]);

    return apiResponse(201, { message: 'Função criada com sucesso', id: roleId });
  } catch (err: any) {
    return ministryFailure(err);
  }
};

// DELETE /ministries/{id}/roles/{roleId}
export const deleteMinistryRole = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'ministries.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireMinistryAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const roleId = event.pathParameters?.roleId;
    if (!roleId) return apiResponse(400, { error: 'ID da função ausente' });

    const { rows: roleRows } = await query(`
      SELECT mr.id, mr.organization_id, mr.ministry_id, m.leader_id
      FROM ministry_roles mr
      INNER JOIN ministries m ON mr.ministry_id = m.id AND m.organization_id = mr.organization_id
      WHERE mr.id = ? AND mr.organization_id = ? LIMIT 1
    `, [roleId, auth.organizationId]);
    if (roleRows.length === 0) return apiResponse(404, { error: 'Função não encontrada' });

    if (roleRows[0].ministry_id !== event.pathParameters?.id) return apiResponse(404, { error: 'ROLE_NOT_FOUND_IN_MINISTRY' });
    await scopedMinistry(auth, roleRows[0].ministry_id);
    const tenantCheck = enforceTenant(auth.user, roleRows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    if (!canUserManageMinistry(auth.user, roleRows[0])) {
      return apiResponse(403, { error: 'Acesso negado: Você só pode remover funções do ministério que lidera.' });
    }

    await query(`DELETE FROM ministry_roles WHERE id = ? AND organization_id = ?`, [roleId, auth.organizationId]);
    return apiResponse(200, { message: 'Função removida com sucesso' });
  } catch (err: any) {
    return ministryFailure(err);
  }
};

// GET /ministries/{id}/volunteers -> Listar bolsão de voluntários
export const listMinistryVolunteers = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'ministries.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireMinistryAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;
    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério ausente' });
    await scopedMinistry(auth, ministryId);

    const { rows: ministryRows } = await query(
      `SELECT id, organization_id, campus_id, leader_id FROM ministries WHERE id = ? AND organization_id = ? LIMIT 1`,
      [ministryId, auth.organizationId]
    );
    if (ministryRows.length === 0) return apiResponse(404, { error: 'Ministério não encontrado' });
    const ministry = ministryRows[0];
    const tenantCheck = enforceTenant(auth.user, ministry.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    if (!canUserManageMinistry(auth.user, ministry)) {
      return apiResponse(403, { error: 'Acesso negado: voluntários disponíveis apenas para o responsável pelo ministério.' });
    }

    const sql = `
      SELECT 
        mv.*,
        m.name as member_name,
        m.phone as member_phone,
        m.email as member_email,
        (
          SELECT COUNT(*) 
          FROM service_roster_items sri 
          INNER JOIN service_schedules ss ON sri.schedule_id = ss.id AND ss.organization_id = sri.organization_id
          WHERE sri.member_id = mv.member_id AND sri.organization_id = mv.organization_id
            AND ss.ministry_id = mv.ministry_id AND sri.status = 'ACCEPTED'
        ) as total_served_count,
        (
          SELECT MAX(ss.service_date)
          FROM service_roster_items sri 
          INNER JOIN service_schedules ss ON sri.schedule_id = ss.id AND ss.organization_id = sri.organization_id
          WHERE sri.member_id = mv.member_id AND sri.organization_id = mv.organization_id
            AND ss.ministry_id = mv.ministry_id AND sri.status = 'ACCEPTED'
        ) as last_served_date
      FROM ministry_volunteers mv
      INNER JOIN members m ON mv.member_id = m.id AND m.organization_id = mv.organization_id
      WHERE mv.ministry_id = ? AND mv.organization_id = ?
      ORDER BY m.name ASC
    `;

    const { rows } = await query(sql, [ministryId, tenantCheck.effectiveOrgId]);
    return apiResponse(200, rows);
  } catch (err: any) {
    return ministryFailure(err);
  }
};

// POST /ministries/{id}/volunteers -> Adicionar ou Atualizar Voluntário no Bolsão
export const addVolunteer = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'ministries.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireMinistryAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério ausente' });
    await scopedMinistry(auth, ministryId);

    const { rows: minRows } = await query(`SELECT organization_id, name, leader_id FROM ministries WHERE id = ? AND organization_id = ? LIMIT 1`, [ministryId, auth.organizationId]);
    if (minRows.length === 0) return apiResponse(404, { error: 'Ministério não encontrado' });

    const tenantCheck = enforceTenant(auth.user, minRows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const { 
      member_id, 
      status = 'ACTIVE', 
      preferred_service_time, 
      roles_csv, 
      notes 
    } = body;

    const isSelfEnrollment = !member_id || member_id === 'me' || member_id === auth.user.userId || (auth.user.email && member_id.toLowerCase() === auth.user.email.toLowerCase());

    if (!isSelfEnrollment) {
      const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
      if (!roleCheck.allowed) return roleCheck.errorResponse!;

      if (!canUserManageMinistry(auth.user, minRows[0])) {
        return apiResponse(403, { error: 'Acesso negado: Você só pode vincular voluntários ao ministério que lidera.' });
      }
    }

    const member = isSelfEnrollment ? await volunteerMember(auth) : null;
    const effectiveMemberId = isSelfEnrollment ? member?.id : member_id;
    if (isSelfEnrollment && !effectiveMemberId) return apiResponse(403, { error: 'MEMBER_NOT_LINKED_TO_ORGANIZATION' });
    const { rows: targetMember } = await query('SELECT id FROM members WHERE organization_id = ? AND id = ? LIMIT 1', [auth.organizationId, effectiveMemberId]);
    if (!targetMember.length) return apiResponse(404, { error: 'MEMBER_NOT_FOUND_IN_ORGANIZATION' });
    const personalEnrollment = event.queryStringParameters?.scope === 'member';
    const effectiveStatus = (isSelfEnrollment && (personalEnrollment || !canUserManageMinistry(auth.user, minRows[0]))) ? 'CANDIDATE' : status;

    if (!effectiveMemberId) return apiResponse(400, { error: 'member_id é obrigatório' });

    // 1. Verificar se membro já está cadastrado neste ministério (Evitar Duplicatas)
    const { rows: existingRows } = await query(
      `SELECT id, status FROM ministry_volunteers WHERE ministry_id = ? AND member_id = ? AND organization_id = ? LIMIT 1`,
      [ministryId, effectiveMemberId, auth.organizationId]
    );

    if (existingRows.length > 0) {
      const existingId = existingRows[0].id;
      await query(`
        UPDATE ministry_volunteers
        SET status = ?, 
            preferred_service_time = COALESCE(?, preferred_service_time), 
            roles_csv = COALESCE(?, roles_csv), 
            notes = COALESCE(?, notes), 
            updated_at = NOW()
        WHERE id = ? AND organization_id = ? AND ministry_id = ?
      `, [effectiveStatus, preferred_service_time || null, roles_csv || null, notes || null, existingId, auth.organizationId, ministryId]);

      await logSecurityEvent({ organizationId: auth.organizationId, user: auth.user, action: 'MINISTRY_VOLUNTEER_UPDATED', resource: 'ministry_volunteers', resourceId: existingId, event });
      return apiResponse(200, { message: 'Cadastro do voluntário atualizado com sucesso', id: existingId, status: effectiveStatus });
    }

    const volId = uuidv4();
    const joinedAt = new Date().toISOString().split('T')[0];

    const q = `
      INSERT INTO ministry_volunteers (id, organization_id, ministry_id, member_id, status, preferred_service_time, roles_csv, notes, joined_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await query(q, [
      volId,
      tenantCheck.effectiveOrgId,
      ministryId,
      effectiveMemberId,
      effectiveStatus,
      preferred_service_time || null,
      roles_csv || null,
      notes || null,
      joinedAt
    ]);

    await logSecurityEvent({ organizationId: auth.organizationId, user: auth.user, action: 'MINISTRY_VOLUNTEER_ADDED', resource: 'ministry_volunteers', resourceId: volId, event });
    return apiResponse(201, { message: 'Voluntário vinculado ao ministério com sucesso', id: volId, status: effectiveStatus });
  } catch (err: any) {
    return ministryFailure(err);
  }
};

// PUT / PATCH /ministries/{id}/volunteers/{volunteerId} -> Atualizar Voluntário (Aprovar, Funções, Status)
export const updateVolunteer = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'ministries.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireMinistryAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    const volunteerId = event.pathParameters?.volunteerId;
    if (!ministryId || !volunteerId) return apiResponse(400, { error: 'IDs ausentes' });

    await scopedMinistry(auth, ministryId);
    const { rows: selectedVolunteer } = await query('SELECT id FROM ministry_volunteers WHERE organization_id = ? AND ministry_id = ? AND id = ? LIMIT 1', [auth.organizationId, ministryId, volunteerId]);
    if (!selectedVolunteer.length) return apiResponse(404, { error: 'VOLUNTEER_NOT_FOUND_IN_MINISTRY' });
    const { rows: minRows } = await query(`SELECT organization_id, name, leader_id FROM ministries WHERE id = ? AND organization_id = ? LIMIT 1`, [ministryId, auth.organizationId]);
    if (minRows.length === 0) return apiResponse(404, { error: 'Ministério não encontrado' });

    const tenantCheck = enforceTenant(auth.user, minRows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    if (!canUserManageMinistry(auth.user, minRows[0])) {
      return apiResponse(403, { error: 'Acesso negado: Você só pode gerenciar voluntários no ministério que lidera.' });
    }

    const body = JSON.parse(event.body || '{}');
    const { status, roles_csv, notes, preferred_service_time } = body;

    const updates: string[] = [];
    const params: any[] = [];

    if (status !== undefined) {
      updates.push('status = ?');
      params.push(status);
    }
    if (roles_csv !== undefined) {
      updates.push('roles_csv = ?');
      params.push(roles_csv);
    }
    if (notes !== undefined) {
      updates.push('notes = ?');
      params.push(notes);
    }
    if (preferred_service_time !== undefined) {
      updates.push('preferred_service_time = ?');
      params.push(preferred_service_time);
    }

    if (updates.length === 0) {
      return apiResponse(400, { error: 'Nenhum campo para atualizar' });
    }

    params.push(volunteerId, ministryId, auth.organizationId);
    await query(`
      UPDATE ministry_volunteers
      SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = ? AND ministry_id = ? AND organization_id = ?
    `, params);

    await logSecurityEvent({ organizationId: auth.organizationId, user: auth.user, action: 'MINISTRY_VOLUNTEER_UPDATED', resource: 'ministry_volunteers', resourceId: volunteerId, event });
    return apiResponse(200, { message: 'Voluntário atualizado com sucesso' });
  } catch (err: any) {
    return ministryFailure(err);
  }
};

// DELETE /ministries/{id}/volunteers/{volunteerId}
export const removeVolunteer = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'ministries.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireMinistryAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const volunteerId = event.pathParameters?.volunteerId;
    if (!volunteerId) return apiResponse(400, { error: 'volunteerId ausente' });

    const { rows: volRows } = await query(`
      SELECT mv.id, mv.organization_id, mv.ministry_id, m.leader_id
      FROM ministry_volunteers mv
      INNER JOIN ministries m ON mv.ministry_id = m.id AND m.organization_id = mv.organization_id
      WHERE mv.id = ? AND mv.organization_id = ? LIMIT 1
    `, [volunteerId, auth.organizationId]);
    if (volRows.length === 0) return apiResponse(404, { error: 'Voluntário não encontrado' });

    if (volRows[0].ministry_id !== event.pathParameters?.id) return apiResponse(404, { error: 'VOLUNTEER_NOT_FOUND_IN_MINISTRY' });
    await scopedMinistry(auth, volRows[0].ministry_id);
    const tenantCheck = enforceTenant(auth.user, volRows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    if (!canUserManageMinistry(auth.user, volRows[0])) {
      return apiResponse(403, { error: 'Acesso negado: Você só pode remover voluntários do ministério que lidera.' });
    }

    await query(`DELETE FROM ministry_volunteers WHERE id = ? AND organization_id = ?`, [volunteerId, auth.organizationId]);
    return apiResponse(200, { message: 'Voluntário removido do ministério' });
  } catch (err: any) {
    return ministryFailure(err);
  }
};

// POST / PATCH /ministries/{id}/volunteers/batch -> Ações em massa (Aprovar, Pausar, Funções, Excluir)
export const batchVolunteers = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'ministries.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireMinistryAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério ausente' });
    await scopedMinistry(auth, ministryId);

    const { rows: minRows } = await query(`SELECT organization_id, name, leader_id FROM ministries WHERE id = ? AND organization_id = ? LIMIT 1`, [ministryId, auth.organizationId]);
    if (minRows.length === 0) return apiResponse(404, { error: 'Ministério não encontrado' });

    const tenantCheck = enforceTenant(auth.user, minRows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    if (!canUserManageMinistry(auth.user, minRows[0])) {
      return apiResponse(403, { error: 'Acesso negado: Você só pode gerenciar voluntários no ministério que lidera.' });
    }

    const body = JSON.parse(event.body || '{}');
    const { volunteer_ids, action, status, roles_csv } = body;

    if (!Array.isArray(volunteer_ids) || volunteer_ids.length === 0) {
      return apiResponse(400, { error: 'Nenhum voluntário selecionado' });
    }

    const placeholders = volunteer_ids.map(() => '?').join(',');
    const { rows: selectedVolunteers } = await query(`SELECT id FROM ministry_volunteers WHERE organization_id = ? AND ministry_id = ? AND id IN (${placeholders})`, [auth.organizationId, ministryId, ...volunteer_ids]);
    if (selectedVolunteers.length !== new Set(volunteer_ids).size) return apiResponse(404, { error: 'VOLUNTEER_NOT_FOUND_IN_MINISTRY' });

    if (action === 'DELETE') {
      await query(
        `DELETE FROM ministry_volunteers WHERE ministry_id = ? AND organization_id = ? AND id IN (${placeholders})`,
        [ministryId, auth.organizationId, ...volunteer_ids]
      );
      await logSecurityEvent({ organizationId: auth.organizationId, user: auth.user, action: 'MINISTRY_VOLUNTEERS_BATCH_' + action, resource: 'ministry_volunteers', resourceId: ministryId, details: { count: volunteer_ids.length }, event });
      return apiResponse(200, { success: true, count: volunteer_ids.length });
    }

    if (action === 'UPDATE_STATUS' && status) {
      await query(
        `UPDATE ministry_volunteers SET status = ? WHERE ministry_id = ? AND organization_id = ? AND id IN (${placeholders})`,
        [status, ministryId, auth.organizationId, ...volunteer_ids]
      );
      await logSecurityEvent({ organizationId: auth.organizationId, user: auth.user, action: 'MINISTRY_VOLUNTEERS_BATCH_' + action, resource: 'ministry_volunteers', resourceId: ministryId, details: { count: volunteer_ids.length }, event });
      return apiResponse(200, { success: true, count: volunteer_ids.length });
    }

    if (action === 'UPDATE_ROLES' && roles_csv !== undefined) {
      await query(
        `UPDATE ministry_volunteers SET roles_csv = ? WHERE ministry_id = ? AND organization_id = ? AND id IN (${placeholders})`,
        [roles_csv, ministryId, auth.organizationId, ...volunteer_ids]
      );
      await logSecurityEvent({ organizationId: auth.organizationId, user: auth.user, action: 'MINISTRY_VOLUNTEERS_BATCH_' + action, resource: 'ministry_volunteers', resourceId: ministryId, details: { count: volunteer_ids.length }, event });
      return apiResponse(200, { success: true, count: volunteer_ids.length });
    }

    return apiResponse(400, { error: 'Ação inválida ou parâmetros ausentes' });
  } catch (err: any) {
    return ministryFailure(err);
  }
};


// GET /ministries/{id}/schedules -> Listar escalas com voluntários alocados
export const listSchedules = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'ministries.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireMinistryAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;
    const roleCheck = enforceRole(auth.user, MINISTRY_VIEW_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério ausente' });
    await scopedMinistry(auth, ministryId);

    const ministry = await scopedMinistry(auth, ministryId);
    const tenantCheck = enforceTenant(auth.user, auth.organizationId);
    const memberOnly = event.queryStringParameters?.scope === 'member';
    if (memberOnly && ministry.status !== 'ACTIVE') return apiResponse(403, { error: 'MINISTRY_INACTIVE' });
    if (!(await canUserViewMinistrySchedules(auth, ministry, memberOnly))) return apiResponse(403, { error: 'MINISTRY_PARTICIPATION_REQUIRED' });

    const timeframe = event.queryStringParameters?.timeframe; // 'upcoming', 'past', 'all'
    const statusParam = memberOnly ? 'PUBLISHED' : event.queryStringParameters?.status;

    let whereSql = `WHERE ss.ministry_id = ? AND ss.organization_id = ?`;
    const params: any[] = [ministryId, tenantCheck.effectiveOrgId];
    if (memberOnly && ministry.campus_id) { whereSql += ' AND ss.campus_id = ?'; params.push(ministry.campus_id); }

    if (timeframe === 'upcoming') {
      whereSql += ` AND (ss.service_date >= CURDATE() AND ss.status != 'COMPLETED')`;
    } else if (timeframe === 'past') {
      whereSql += ` AND (ss.service_date < CURDATE() OR ss.status = 'COMPLETED')`;
    }

    if (statusParam && statusParam !== 'all') {
      whereSql += ` AND ss.status = ?`;
      params.push(statusParam);
    }

    const scheduleCampus = campusFilter(auth, 'ss');
    whereSql += scheduleCampus.sql; params.push(...scheduleCampus.params);

    // 1. Buscar escalas
    const { rows: schedules } = await query(`
      SELECT ss.*,
        COUNT(sri.id) as total_slots,
        COUNT(CASE WHEN sri.status = 'ACCEPTED' THEN 1 END) as accepted_count,
        COUNT(CASE WHEN sri.status = 'DECLINED' THEN 1 END) as declined_count,
        COUNT(CASE WHEN sri.status = 'PENDING' THEN 1 END) as pending_count,
        COUNT(CASE WHEN sri.status = 'SWAP_REQUESTED' THEN 1 END) as swap_requested_count
      FROM service_schedules ss
      LEFT JOIN service_roster_items sri ON ss.id = sri.schedule_id AND sri.organization_id = ss.organization_id
      ${whereSql}
      GROUP BY ss.id
      ORDER BY ss.service_date DESC, ss.service_time ASC
      LIMIT 100
    `, params);

    // 2. Buscar itens de escala detalhados (incluindo dados de solicitação de troca se houver)
    if (schedules.length > 0) {
      const scheduleIds = schedules.map(() => '?').join(',');
      const { rows: items } = await query(`
        SELECT 
          sri.*,
          mr.name as role_name,
          m.name as member_name,
          m.phone as member_phone,
          m.email as member_email,
          sw.id as swap_id,
          sw.reason as swap_reason,
          sw.target_member_id as swap_target_member_id,
          sw.status as swap_status,
          sw.created_at as swap_created_at,
          sw_target_m.name as swap_target_member_name
        FROM service_roster_items sri
        INNER JOIN ministry_roles mr ON sri.role_id = mr.id AND mr.organization_id = sri.organization_id
        INNER JOIN members m ON sri.member_id = m.id AND m.organization_id = sri.organization_id
        LEFT JOIN service_roster_swaps sw ON sw.roster_item_id = sri.id AND sw.organization_id = sri.organization_id AND sw.status = 'PENDING'
        LEFT JOIN members sw_target_m ON sw.target_member_id = sw_target_m.id AND sw_target_m.organization_id = sri.organization_id
        WHERE sri.schedule_id IN (${scheduleIds}) AND sri.organization_id = ?
        ORDER BY mr.name ASC, m.name ASC
      `, [...schedules.map(s => s.id), tenantCheck.effectiveOrgId]);

      const fullSchedules = schedules.map(sch => ({
        ...sch,
        roster_items: items.filter(it => it.schedule_id === sch.id)
      }));

      return apiResponse(200, fullSchedules);
    }

    return apiResponse(200, []);
  } catch (err: any) {
    return ministryFailure(err);
  }
};

// POST /ministries/{id}/schedules -> Criar ou Atualizar Escala de Culto com Voluntários
export const createOrUpdateSchedule = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'ministries.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireMinistryAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério ausente' });
    await scopedMinistry(auth, ministryId);

    const { rows: minRows } = await query(`SELECT organization_id, campus_id, name, leader_id FROM ministries WHERE id = ? AND organization_id = ? LIMIT 1`, [ministryId, auth.organizationId]);
    if (minRows.length === 0) return apiResponse(404, { error: 'Ministério não encontrado' });
    const min = minRows[0];

    const tenantCheck = enforceTenant(auth.user, min.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    if (!canUserManageMinistry(auth.user, min)) {
      return apiResponse(403, { error: 'Acesso negado: Você só pode criar ou alterar escalas do ministério que lidera.' });
    }

    const body = JSON.parse(event.body || '{}');
    const {
      id,
      title,
      service_date,
      service_time,
      notes,
      status = 'PUBLISHED',
      roster_items = [] // Array<{ role_id, member_id }>
    } = body;

    if (!title || !service_date || !service_time) {
      return apiResponse(400, { error: 'Título, data e horário do culto são obrigatórios' });
    }

    if (id) {
      const existing = await authorizeResource({ ...event, headers: { ...event.headers, 'x-organization-id': tenantCheck.effectiveOrgId } }, 'service_schedules', id, MINISTRY_ADMIN_ROLES);
      if ('errorResponse' in existing) return existing.errorResponse;
      if (existing.record.ministry_id !== ministryId) return apiResponse(403, { error: 'Escala pertence a outro ministério' });
    }
    await validateRoster(auth, { ...min, id: ministryId }, roster_items);
    const scheduleId = id || uuidv4();
    const effectiveCampusId = min.campus_id || 'campus_sede';
    const createdBy = auth.user.userId || 'usr_pastor';

    // 1. Salvar ou atualizar cabeçalho da escala
    await query(`
      INSERT INTO service_schedules (id, organization_id, campus_id, ministry_id, title, service_date, service_time, notes, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        title = VALUES(title),
        service_date = VALUES(service_date),
        service_time = VALUES(service_time),
        notes = VALUES(notes),
        status = VALUES(status),
        updated_at = NOW()
    `, [
      scheduleId,
      tenantCheck.effectiveOrgId,
      effectiveCampusId,
      ministryId,
      title,
      service_date,
      service_time,
      notes || null,
      status,
      createdBy
    ]);

    // 2. Se informou itens da escala, sincronizar
    if (Array.isArray(roster_items) && roster_items.length > 0) {
      // Deletar itens antigos da escala e recriar
      await query(`DELETE FROM service_roster_items WHERE schedule_id = ? AND organization_id = ?`, [scheduleId, auth.organizationId]);

      for (const item of roster_items) {
        if (!item.role_id || !item.member_id) continue;
        const itemId = uuidv4();
        const itemStatus = item.status || 'PENDING';
        await query(`
          INSERT INTO service_roster_items (id, organization_id, schedule_id, role_id, member_id, status)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [itemId, tenantCheck.effectiveOrgId, scheduleId, item.role_id, item.member_id, itemStatus]);
      }
    }

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: id ? 'UPDATE_SCHEDULE' : 'CREATE_SCHEDULE',
      resource: 'service_schedules',
      resourceId: scheduleId,
      details: { ministry_name: min.name, title, service_date, items_count: roster_items.length },
      event
    });

    return apiResponse(id ? 200 : 201, {
      message: 'Escala salva e publicada com sucesso!',
      id: scheduleId
    });
  } catch (err: any) {
    return ministryFailure(err);
  }
};

// POST /ministries/{id}/schedules/batch -> Criar múltiplas escalas em lote (Gerador do Mês)
export const createBatchSchedules = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'ministries.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireMinistryAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério é obrigatório' });
    await scopedMinistry(auth, ministryId);

    const { rows: minRows } = await query(`SELECT organization_id, campus_id, name, leader_id FROM ministries WHERE id = ? AND organization_id = ? LIMIT 1`, [ministryId, auth.organizationId]);
    if (minRows.length === 0) return apiResponse(404, { error: 'Ministério não encontrado' });
    const min = minRows[0];

    const tenantCheck = enforceTenant(auth.user, min.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    if (!canUserManageMinistry(auth.user, min)) {
      return apiResponse(403, { error: 'Acesso negado: Você só pode criar escalas no ministério pelo qual é responsável.' });
    }

    const body = JSON.parse(event.body || '{}');
    const { schedules } = body;

    if (!Array.isArray(schedules) || schedules.length === 0) {
      return apiResponse(400, { error: 'Lista de escalas é obrigatória' });
    }

    const effectiveCampusId = min.campus_id || 'campus_sede';
    const createdBy = auth.user.userId || 'usr_pastor';
    for (const sch of schedules) await validateRoster(auth, { ...min, id: ministryId }, sch.roster_items || []);
    const createdIds: string[] = [];

    for (const sch of schedules) {
      if (!sch.title || !sch.service_date || !sch.service_time) continue;

      if (sch.id) {
        const existing = await authorizeResource({ ...event, headers: { ...event.headers, 'x-organization-id': tenantCheck.effectiveOrgId } }, 'service_schedules', sch.id, MINISTRY_ADMIN_ROLES);
        if ('errorResponse' in existing) return existing.errorResponse;
        if (existing.record.ministry_id !== ministryId) return apiResponse(403, { error: 'Escala pertence a outro ministério' });
      }
      const scheduleId = sch.id || uuidv4();
      createdIds.push(scheduleId);

      await query(`
        INSERT INTO service_schedules (id, organization_id, campus_id, ministry_id, title, service_date, service_time, notes, status, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          title = VALUES(title),
          service_date = VALUES(service_date),
          service_time = VALUES(service_time),
          notes = VALUES(notes),
          status = VALUES(status),
          updated_at = NOW()
      `, [
        scheduleId,
        tenantCheck.effectiveOrgId,
        effectiveCampusId,
        ministryId,
        sch.title,
        sch.service_date,
        sch.service_time || '18:00',
        sch.notes || null,
        sch.status || 'PUBLISHED',
        createdBy
      ]);

      if (Array.isArray(sch.roster_items) && sch.roster_items.length > 0) {
        await query(`DELETE FROM service_roster_items WHERE schedule_id = ? AND organization_id = ?`, [scheduleId, auth.organizationId]);
        for (const item of sch.roster_items) {
          if (!item.role_id || !item.member_id) continue;
          const itemId = uuidv4();
          await query(`
            INSERT INTO service_roster_items (id, organization_id, schedule_id, role_id, member_id, status)
            VALUES (?, ?, ?, ?, ?, 'PENDING')
          `, [itemId, tenantCheck.effectiveOrgId, scheduleId, item.role_id, item.member_id]);
        }
      }
    }

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'BATCH_CREATE_SCHEDULES',
      resource: 'service_schedules',
      details: { ministry_name: min.name, count: createdIds.length },
      event
    });

    return apiResponse(201, {
      message: `${createdIds.length} escala(s) criada(s) com sucesso!`,
      count: createdIds.length,
      created_ids: createdIds
    });
  } catch (err: any) {
    return ministryFailure(err);
  }
};

// DELETE /ministries/{id}/schedules/{scheduleId}
export const deleteSchedule = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'ministries.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireMinistryAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const scheduleId = event.pathParameters?.scheduleId;
    if (!scheduleId) return apiResponse(400, { error: 'scheduleId ausente' });

    const { rows: schRows } = await query(`
      SELECT ss.id, ss.organization_id, ss.campus_id, ss.ministry_id, m.leader_id
      FROM service_schedules ss
      INNER JOIN ministries m ON ss.ministry_id = m.id AND m.organization_id = ss.organization_id
      WHERE ss.id = ? AND ss.organization_id = ? LIMIT 1
    `, [scheduleId, auth.organizationId]);
    if (schRows.length === 0) return apiResponse(404, { error: 'Escala não encontrada' });
    const sch = schRows[0];
    if (sch.ministry_id !== event.pathParameters?.id) return apiResponse(404, { error: 'SCHEDULE_NOT_FOUND_IN_MINISTRY' });
    assertCampus(auth, sch.campus_id);

    const tenantCheck = enforceTenant(auth.user, sch.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    if (!canUserManageMinistry(auth.user, sch)) {
      return apiResponse(403, { error: 'Acesso negado: Você só pode excluir escalas do ministério que lidera.' });
    }

    await query(`DELETE FROM service_roster_items WHERE schedule_id = ? AND organization_id = ?`, [scheduleId, auth.organizationId]);
    await query(`DELETE FROM service_schedules WHERE id = ? AND organization_id = ?`, [scheduleId, auth.organizationId]);

    return apiResponse(200, { message: 'Escala excluída com sucesso' });
  } catch (err: any) {
    return ministryFailure(err);
  }
};

// GET /ministries/conflicts?date=YYYY-MM-DD (ou start_date=...&end_date=...)&schedule_id=...
export const getScheduleConflicts = async (event: any): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'ministries.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireMinistryAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const managementRole = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!managementRole.allowed) return managementRole.errorResponse!;
    const qp = event.queryStringParameters || {};
    const startDate = qp.start_date || qp.date;
    const endDate = qp.end_date || qp.date;
    const scheduleId = qp.schedule_id || null;
    const orgId = auth.organizationId || qp.organization_id || 'org_default';

    if (!startDate) {
      return apiResponse(400, { error: 'Parâmetro date ou start_date é obrigatório (YYYY-MM-DD)' });
    }

    const conflictCampus = campusFilter(auth, 'm');
    const rosterCampus = campusFilter(auth, 'ss');
    // 1. Voluntários com blockout ativo na data ou no período solicitado
    const { rows: blockouts } = await query(`
      SELECT vb.id, vb.member_id, m.name as member_name, vb.start_date, vb.end_date, vb.reason
      FROM volunteer_blockouts vb
      INNER JOIN members m ON vb.member_id = m.id AND m.organization_id = vb.organization_id
      WHERE vb.organization_id = ? 
        AND vb.start_date <= ? AND vb.end_date >= ? ${conflictCampus.sql}
    `, [orgId, endDate, startDate, ...conflictCampus.params]);

    // 2. Voluntários já escalados em outros ministérios ou escalas na data ou período
    const { rows: doubleBookings } = await query(`
      SELECT 
        sri.member_id,
        m.name as member_name,
        ss.id as schedule_id,
        ss.title as service_title,
        ss.service_date,
        ss.service_time,
        min.name as ministry_name,
        mr.name as role_name,
        sri.status as roster_status
      FROM service_roster_items sri
      INNER JOIN service_schedules ss ON sri.schedule_id = ss.id AND ss.organization_id = sri.organization_id
      INNER JOIN ministries min ON ss.ministry_id = min.id AND min.organization_id = ss.organization_id
      INNER JOIN ministry_roles mr ON sri.role_id = mr.id AND mr.organization_id = sri.organization_id
      INNER JOIN members m ON sri.member_id = m.id AND m.organization_id = sri.organization_id
      WHERE ss.organization_id = ?
        AND ss.service_date >= ? AND ss.service_date <= ?
        AND (? IS NULL OR ss.id != ?) ${rosterCampus.sql}
    `, [orgId, startDate, endDate, scheduleId, scheduleId, ...rosterCampus.params]);

    return apiResponse(200, {
      date: startDate,
      start_date: startDate,
      end_date: endDate,
      blockouts,
      doubleBookings
    });
  } catch (err: any) {
    return ministryFailure(err);
  }
};

// POST /ministries/{id}/schedules/{scheduleId}/roster/{rosterItemId}/resolve-swap
export const resolveRosterSwapByLeader = async (event: any): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'ministries.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireMinistryAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    const scheduleId = event.pathParameters?.scheduleId;
    const rosterItemId = event.pathParameters?.rosterItemId;

    if (!ministryId || !scheduleId || !rosterItemId) {
      return apiResponse(400, { error: 'Parâmetros ministryId, scheduleId e rosterItemId são obrigatórios' });
    }

    const authorizedMinistry = await scopedMinistry(auth, ministryId);
    if (!canUserManageMinistry(auth.user, authorizedMinistry)) return apiResponse(403, { error: 'NOT_MINISTRY_LEADER' });
    const body = JSON.parse(event.body || '{}');
    const { new_member_id, notes } = body;
    if (!new_member_id) {
      return apiResponse(400, { error: 'O novo voluntário substituto (new_member_id) é obrigatório' });
    }

    // Buscar item e schedule
    const { rows: itemRows } = await query(`
      SELECT sri.*, ss.organization_id, ss.title as service_title, m.name as current_member_name
      FROM service_roster_items sri
      INNER JOIN service_schedules ss ON sri.schedule_id = ss.id AND ss.organization_id = sri.organization_id
      INNER JOIN members m ON sri.member_id = m.id AND m.organization_id = sri.organization_id
      WHERE sri.id = ? AND ss.id = ? AND ss.ministry_id = ? AND sri.organization_id = ?
      LIMIT 1
    `, [rosterItemId, scheduleId, ministryId, auth.organizationId]);

    if (itemRows.length === 0) {
      return apiResponse(404, { error: 'Item de escala não encontrado para este ministério' });
    }

    const item = itemRows[0];
    const tenantCheck = enforceTenant(auth.user, item.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    await validateRoster(auth, { ...authorizedMinistry, id: ministryId }, [{ member_id: new_member_id, role_id: item.role_id }]);
    // Atualizar o item da escala com o novo membro
    await query(`
      UPDATE service_roster_items 
      SET member_id = ?, status = 'ACCEPTED', confirmed_at = NOW(), decline_reason = NULL, notes = COALESCE(?, notes)
      WHERE id = ? AND organization_id = ?
    `, [new_member_id, notes || null, rosterItemId, auth.organizationId]);

    // Atualizar o swap para ACCEPTED se houver pendente
    await query(`
      UPDATE service_roster_swaps 
      SET status = 'ACCEPTED', target_member_id = ?, responded_at = NOW()
      WHERE roster_item_id = ? AND organization_id = ? AND status = 'PENDING'
    `, [new_member_id, rosterItemId, auth.organizationId]);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'SERVICE_ROSTER_SWAP_RESOLVED_BY_LEADER',
      resource: 'service_roster_items',
      resourceId: rosterItemId,
      details: {
        schedule_id: scheduleId,
        previous_member_id: item.member_id,
        new_member_id,
        leader_id: auth.user.userId
      },
      event
    });

    return apiResponse(200, { message: '✓ Substituição realizada com sucesso na escala pelo líder!' });
  } catch (err: any) {
    return ministryFailure(err);
  }
};

// POST /ministries/schedules/{scheduleId}/remind-volunteers
export const sendScheduleReminders = async (event: any): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'ministries.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireMinistryAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const scheduleId = event.pathParameters?.scheduleId;
    if (!scheduleId) return apiResponse(400, { error: 'scheduleId ausente' });

    const { rows: schedRows } = await query(`
      SELECT ss.id, ss.organization_id, ss.campus_id, ss.ministry_id, min.leader_id, ss.title, ss.service_date, ss.service_time, ss.notes, min.name as ministry_name
      FROM service_schedules ss
      INNER JOIN ministries min ON ss.ministry_id = min.id AND min.organization_id = ss.organization_id
      WHERE ss.id = ? AND ss.organization_id = ? LIMIT 1
    `, [scheduleId, auth.organizationId]);

    if (schedRows.length === 0) return apiResponse(404, { error: 'Escala não encontrada' });
    const sched = schedRows[0];
    assertCampus(auth, sched.campus_id);
    const reminderMinistry = await scopedMinistry(auth, sched.ministry_id);
    if (!canUserManageMinistry(auth.user, reminderMinistry)) return apiResponse(403, { error: 'NOT_MINISTRY_LEADER' });

    const tenantCheck = enforceTenant(auth.user, sched.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    const { rows: volunteers } = await query(`
      SELECT sri.id, sri.status, m.id as member_id, m.name, m.phone, mr.name as role_name
      FROM service_roster_items sri
      INNER JOIN members m ON sri.member_id = m.id AND m.organization_id = sri.organization_id
      INNER JOIN ministry_roles mr ON sri.role_id = mr.id AND mr.organization_id = sri.organization_id
      WHERE sri.schedule_id = ? AND sri.organization_id = ? AND sri.status = 'ACCEPTED'
    `, [scheduleId, auth.organizationId]);

    const formattedDate = new Date(sched.service_date).toLocaleDateString('pt-BR');
    const reminders = volunteers.map((v: any) => {
      const cleanPhone = (v.phone || '').replace(/\D/g, '');
      const text = `Paz do Senhor, ${v.name}! 🕊️ Passando para lembrar da sua escala amanhã no culto "${sched.title}" (${formattedDate} às ${sched.service_time}).\nSua função: *${v.role_name}* (${sched.ministry_name}).\nContamos com você! Chegue com antecedência para oração e alinhamento.`;
      return {
        member_id: v.member_id,
        name: v.name,
        phone: v.phone,
        role_name: v.role_name,
        whatsapp_url: cleanPhone ? `https://wa.me/55${cleanPhone}?text=${encodeURIComponent(text)}` : null,
        message: text
      };
    });

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'SERVICE_SCHEDULE_REMINDERS_PREPARED',
      resource: 'service_schedules',
      resourceId: scheduleId,
      details: { total_volunteers: reminders.length },
      event
    });

    return apiResponse(200, {
      message: `${reminders.length} voluntários confirmados identificados para lembrete`,
      total: reminders.length,
      schedule: {
        title: sched.title,
        service_date: sched.service_date,
        service_time: sched.service_time
      },
      reminders
    });
  } catch (err: any) {
    return ministryFailure(err);
  }
};

// Handler consolidado para otimização do CloudFormation (ANY /ministries e ANY /volunteers)
const routeMinistries = async (event: any): Promise<APIGatewayProxyResult> => {
  const method = (event.requestContext?.http?.method || event.httpMethod || 'GET').toUpperCase();
  const rawPath = event.rawPath || event.path || '';

  // Suporte a CORS Preflight OPTIONS
  if (method === 'OPTIONS') {
    return apiResponse(200, { ok: true });
  }
  const auth = await requireMinistryAuth(event);
  if ('errorResponse' in auth) return auth.errorResponse;
  const tenantCheck = enforceTenant(auth.user, event.headers?.['x-organization-id'] || event.queryStringParameters?.organization_id);
  if (!tenantCheck.allowed) return tenantCheck.errorResponse!;


  if (rawPath === '/volunteers/applications' && method === 'POST') return applyToMinistry(event);

  // 1. /volunteers/blockouts
  if (rawPath.startsWith('/volunteers/blockouts') || rawPath.startsWith('/volunteers/my-blockouts')) {
    if (method === 'GET') return getMyBlockouts(event);
    if (method === 'POST') return createBlockout(event);
    if (method === 'DELETE') {
      const parts = rawPath.split('/').filter(Boolean);
      if (!event.pathParameters) event.pathParameters = {};
      event.pathParameters.id = parts[parts.length - 1];
      return deleteBlockout(event);
    }
  }

  // 2. /volunteers/swaps
  if (rawPath.includes('/volunteers/swaps/pending') && method === 'GET') {
    return getMyPendingSwaps(event);
  }
  if (rawPath.includes('/volunteers/swaps/') && rawPath.endsWith('/respond') && method === 'POST') {
    const parts = rawPath.split('/').filter(Boolean);
    const swapIdx = parts.indexOf('swaps');
    if (!event.pathParameters) event.pathParameters = {};
    event.pathParameters.swapId = parts[swapIdx + 1];
    return respondToSwap(event);
  }
  if ((rawPath.includes('/volunteers/swaps/') && rawPath.endsWith('/cancel') && method === 'POST') || (rawPath.endsWith('/volunteers/swaps/cancel') && method === 'POST')) {
    const parts = rawPath.split('/').filter(Boolean);
    const swapIdx = parts.indexOf('swaps');
    if (!event.pathParameters) event.pathParameters = {};
    if (parts[swapIdx + 1] !== 'cancel') {
      event.pathParameters.swapId = parts[swapIdx + 1];
    }
    return cancelRosterSwap(event);
  }

  // 3. /volunteers/schedules/eligible-peers
  if (rawPath.includes('/eligible-peers') && method === 'GET') {
    return getEligiblePeersForSwap(event);
  }

  // 4. /volunteers/schedules/roster/{rosterItemId}/swap
  if (rawPath.includes('/roster/') && rawPath.endsWith('/swap') && method === 'POST') {
    const parts = rawPath.split('/').filter(Boolean);
    const rosIdx = parts.indexOf('roster');
    if (!event.pathParameters) event.pathParameters = {};
    event.pathParameters.rosterItemId = parts[rosIdx + 1];
    return requestRosterSwap(event);
  }

  // 5. /volunteers/my-schedules
  if (rawPath.startsWith('/volunteers/my-schedules') && method === 'GET') {
    return getMySchedules(event);
  }

  // 6. /volunteers/schedules/{id}/respond
  if (rawPath.includes('/volunteers/schedules/') && rawPath.endsWith('/respond') && method === 'POST') {
    const parts = rawPath.split('/');
    const rosterItemId = parts[parts.indexOf('schedules') + 1];
    if (!event.pathParameters) event.pathParameters = {};
    event.pathParameters.rosterItemId = rosterItemId;
    return respondRosterItem(event);
  }

  // 7. /ministries/schedules/{scheduleId}/remind-volunteers
  if (rawPath.includes('/remind-volunteers') && method === 'POST') {
    const parts = rawPath.split('/').filter(Boolean);
    const schedIdx = parts.indexOf('schedules');
    if (!event.pathParameters) event.pathParameters = {};
    event.pathParameters.scheduleId = parts[schedIdx + 1];
    return sendScheduleReminders(event);
  }

  // 8. /ministries/conflicts
  if (rawPath.includes('/ministries/conflicts') && method === 'GET') {
    return getScheduleConflicts(event);
  }

  // 9. /ministries/{id}/roles
  if (rawPath.includes('/roles')) {
    const parts = rawPath.split('/');
    const minIdx = parts.indexOf('ministries');
    const minId = parts[minIdx + 1];
    if (!event.pathParameters) event.pathParameters = {};
    event.pathParameters.id = minId;

    if (parts.length > minIdx + 3) {
      event.pathParameters.roleId = parts[minIdx + 3];
      if (method === 'DELETE') return deleteMinistryRole(event);
    }
    if (method === 'GET') return listMinistryRoles(event);
    if (method === 'POST') return createMinistryRole(event);
  }

  // 10. /ministries/{id}/volunteers
  if (rawPath.includes('/volunteers')) {
    const parts = rawPath.split('/');
    const minIdx = parts.indexOf('ministries');
    const minId = parts[minIdx + 1];
    if (!event.pathParameters) event.pathParameters = {};
    event.pathParameters.id = minId;

    if (parts.length > minIdx + 3) {
      const sub = parts[minIdx + 3];
      if (sub === 'batch') {
        return batchVolunteers(event);
      }
      event.pathParameters.volunteerId = sub;
      if (method === 'DELETE') return removeVolunteer(event);
      if (method === 'PUT' || method === 'PATCH') return updateVolunteer(event);
    }
    if (method === 'GET') return listMinistryVolunteers(event);
    if (method === 'POST') return addVolunteer(event);
  }

  // 11. /ministries/{id}/schedules
  if (rawPath.includes('/schedules')) {
    const parts = rawPath.split('/');
    const minIdx = parts.indexOf('ministries');
    const minId = parts[minIdx + 1];
    if (!event.pathParameters) event.pathParameters = {};
    event.pathParameters.id = minId;

    if (rawPath.endsWith('/batch') && method === 'POST') {
      return createBatchSchedules(event);
    }

    if (rawPath.includes('/roster/')) {
      const schedIdx = parts.indexOf('schedules');
      const rosIdx = parts.indexOf('roster');
      event.pathParameters.scheduleId = parts[schedIdx + 1];
      event.pathParameters.rosterItemId = parts[rosIdx + 1];

      if (rawPath.endsWith('/resolve-swap') && method === 'POST') {
        return resolveRosterSwapByLeader(event);
      }
      if (rawPath.endsWith('/cancel-swap') && method === 'POST') {
        return cancelRosterSwap(event);
      }
    }

    if (parts.length > minIdx + 3) {
      event.pathParameters.scheduleId = parts[minIdx + 3];
      if (method === 'DELETE') return deleteSchedule(event);
    }
    if (method === 'GET') return listSchedules(event);
    if (method === 'POST') return createOrUpdateSchedule(event);
  }

  // 12. /ministries ou /ministries/{id}
  const parts = rawPath.split('/').filter(Boolean);
  if (parts.length === 2 && parts[0] === 'ministries') {
    if (!event.pathParameters) event.pathParameters = {};
    event.pathParameters.id = parts[1];
    if (method === 'DELETE') return deleteMinistry(event);
  }

  if (method === 'GET') return listMinistries(event);
  if (method === 'POST') return createOrUpdateMinistry(event);

  return apiResponse(404, { error: 'Rota ministerial não encontrada' });
};


export const ministriesHandler = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const response = await routeMinistries(event);
    return { ...response, headers: { ...response.headers, 'Cache-Control': 'no-store, private', Vary: 'Authorization, x-organization-id, x-campus-id' } };
  } catch (error) { return ministryFailure(error); }
};
