import { authorizeResource } from '../services/tenantResource';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant } from '../services/authMiddleware';
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

async function canUserViewMinistrySchedules(
  user: any,
  ministry: { id: string; organization_id: string; leader_id?: string | null }
): Promise<boolean> {
  if (canUserManageMinistry(user, ministry)) return true;
  const { rows } = await query(
    `SELECT id FROM ministry_volunteers
     WHERE organization_id = ? AND ministry_id = ? AND member_id = ?
       AND status IN ('ACTIVE', 'TRAINING')
     LIMIT 1`,
    [ministry.organization_id, ministry.id, user.userId]
  );
  return rows.length > 0;
}

// GET /ministries -> Listar Ministérios com contadores de voluntários e funções
export const listMinistries = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;
    const roleCheck = enforceRole(auth.user, MINISTRY_VIEW_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const user = auth.user;
    const requestedOrgId = event.queryStringParameters?.organization_id;
    const campusId = event.queryStringParameters?.campus_id;
    const statusParam = event.queryStringParameters?.status; // 'ACTIVE', 'INACTIVE' or 'all'
    const managementScope = event.queryStringParameters?.scope === 'manage';

    const tenantScope = enforceTenant(user, requestedOrgId);
    if (!tenantScope.allowed) return tenantScope.errorResponse!;
    const orgId = tenantScope.effectiveOrgId;

    let volunteerSelect = `
        NULL as my_volunteer_status,
        NULL as my_volunteer_roles,
        NULL as my_volunteer_joined_at,
    `;
    const params: any[] = [];

    if (user.userId) {
      volunteerSelect = `
        (SELECT mv.status FROM ministry_volunteers mv WHERE mv.organization_id = m.organization_id AND mv.ministry_id = m.id AND mv.member_id = ? LIMIT 1) as my_volunteer_status,
        (SELECT mv.roles_csv FROM ministry_volunteers mv WHERE mv.organization_id = m.organization_id AND mv.ministry_id = m.id AND mv.member_id = ? LIMIT 1) as my_volunteer_roles,
        (SELECT mv.joined_at FROM ministry_volunteers mv WHERE mv.organization_id = m.organization_id AND mv.ministry_id = m.id AND mv.member_id = ? LIMIT 1) as my_volunteer_joined_at,
      `;
      params.push(user.userId, user.userId, user.userId);
    }

    let sql = `
      SELECT 
        m.*,
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

    if (campusId && campusId !== 'all') {
      sql += ` AND (m.campus_id = ? OR m.campus_id IS NULL)`;
      params.push(campusId);
    }

    sql += ` ORDER BY m.name ASC`;

    const { rows } = await query(sql, params);
    return apiResponse(200, rows);
  } catch (err: any) {
    console.error('Erro ao listar ministérios:', err);
    return apiResponse(500, { error: 'Erro ao listar ministérios' });
  }
};

// POST /ministries -> Criar ou Atualizar Ministério
export const createOrUpdateMinistry = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
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
      campus_id = 'campus_sede', 
      organization_id 
    } = body;

    const tenantCheck = enforceTenant(auth.user, organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    if (!name) return apiResponse(400, { error: 'Nome do ministério é obrigatório' });

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
      const { rows: existingRows } = await query(`SELECT leader_id FROM ministries WHERE id = ? LIMIT 1`, [id]);
      if (existingRows.length === 0) return apiResponse(404, { error: 'Ministério não encontrado' });
      if (!canUserManageMinistry(auth.user, existingRows[0])) {
        return apiResponse(403, { error: 'Acesso negado: Você só pode editar o ministério pelo qual é responsável.' });
      }
    }

    // Resolver nome do líder caso tenha sido passado apenas o leader_id
    let finalLeaderName = leader_name;
    if (leader_id && (!finalLeaderName || finalLeaderName === '')) {
      const { rows: memRows } = await query(`SELECT name FROM members WHERE id = ? LIMIT 1`, [leader_id]);
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
      campus_id,
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
    console.error('Erro ao salvar ministério:', err);
    return apiResponse(500, { error: 'Erro ao salvar ministério' });
  }
};

// DELETE /ministries/{id}
export const deleteMinistry = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN']);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID faltante' });

    const { rows } = await query(`SELECT organization_id, name FROM ministries WHERE id = ? LIMIT 1`, [id]);
    if (rows.length === 0) return apiResponse(404, { message: 'Ministério não encontrado' });

    const tenantCheck = enforceTenant(auth.user, rows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    await query(`DELETE FROM ministries WHERE id = ?`, [id]);

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
    return apiResponse(500, { error: 'Erro ao excluir ministério' });
  }
};

// GET /ministries/{id}/roles -> Listar funções do ministério
export const listMinistryRoles = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;
    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério ausente' });

    const { rows: ministryRows } = await query(
      `SELECT id, organization_id, leader_id FROM ministries WHERE id = ? LIMIT 1`,
      [ministryId]
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
    return apiResponse(500, { error: 'Erro ao listar funções do ministério' });
  }
};

// POST /ministries/{id}/roles -> Criar função no ministério
export const createMinistryRole = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério ausente' });

    const { rows: minRows } = await query(`SELECT organization_id, leader_id FROM ministries WHERE id = ? LIMIT 1`, [ministryId]);
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
    return apiResponse(500, { error: 'Erro ao criar função' });
  }
};

// DELETE /ministries/{id}/roles/{roleId}
export const deleteMinistryRole = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const roleId = event.pathParameters?.roleId;
    if (!roleId) return apiResponse(400, { error: 'ID da função ausente' });

    const { rows: roleRows } = await query(`
      SELECT mr.id, mr.organization_id, mr.ministry_id, m.leader_id
      FROM ministry_roles mr
      INNER JOIN ministries m ON mr.ministry_id = m.id
      WHERE mr.id = ? LIMIT 1
    `, [roleId]);
    if (roleRows.length === 0) return apiResponse(404, { error: 'Função não encontrada' });

    const tenantCheck = enforceTenant(auth.user, roleRows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    if (!canUserManageMinistry(auth.user, roleRows[0])) {
      return apiResponse(403, { error: 'Acesso negado: Você só pode remover funções do ministério que lidera.' });
    }

    await query(`DELETE FROM ministry_roles WHERE id = ?`, [roleId]);
    return apiResponse(200, { message: 'Função removida com sucesso' });
  } catch (err: any) {
    return apiResponse(500, { error: 'Erro ao remover função' });
  }
};

// GET /ministries/{id}/volunteers -> Listar bolsão de voluntários
export const listMinistryVolunteers = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;
    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério ausente' });

    const { rows: ministryRows } = await query(
      `SELECT id, organization_id, leader_id FROM ministries WHERE id = ? LIMIT 1`,
      [ministryId]
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
    console.error('Erro ao listar voluntários:', err);
    return apiResponse(500, { error: 'Erro ao listar voluntários' });
  }
};

// POST /ministries/{id}/volunteers -> Adicionar ou Atualizar Voluntário no Bolsão
export const addVolunteer = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério ausente' });

    const { rows: minRows } = await query(`SELECT organization_id, name, leader_id FROM ministries WHERE id = ? LIMIT 1`, [ministryId]);
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

    const effectiveMemberId = isSelfEnrollment ? auth.user.userId : member_id;
    const effectiveStatus = (isSelfEnrollment && !canUserManageMinistry(auth.user, minRows[0])) ? 'CANDIDATE' : status;

    if (!effectiveMemberId) return apiResponse(400, { error: 'member_id é obrigatório' });

    // 1. Verificar se membro já está cadastrado neste ministério (Evitar Duplicatas)
    const { rows: existingRows } = await query(
      `SELECT id, status FROM ministry_volunteers WHERE ministry_id = ? AND member_id = ? LIMIT 1`,
      [ministryId, effectiveMemberId]
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
        WHERE id = ?
      `, [effectiveStatus, preferred_service_time || null, roles_csv || null, notes || null, existingId]);

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

    return apiResponse(201, { message: 'Voluntário vinculado ao ministério com sucesso', id: volId, status: effectiveStatus });
  } catch (err: any) {
    console.error('Erro ao adicionar voluntário:', err);
    return apiResponse(500, { error: 'Erro ao adicionar voluntário' });
  }
};

// PUT / PATCH /ministries/{id}/volunteers/{volunteerId} -> Atualizar Voluntário (Aprovar, Funções, Status)
export const updateVolunteer = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    const volunteerId = event.pathParameters?.volunteerId;
    if (!ministryId || !volunteerId) return apiResponse(400, { error: 'IDs ausentes' });

    const { rows: minRows } = await query(`SELECT organization_id, name, leader_id FROM ministries WHERE id = ? LIMIT 1`, [ministryId]);
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

    params.push(volunteerId, ministryId);
    await query(`
      UPDATE ministry_volunteers
      SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = ? AND ministry_id = ?
    `, params);

    return apiResponse(200, { message: 'Voluntário atualizado com sucesso' });
  } catch (err: any) {
    console.error('Erro ao atualizar voluntário:', err);
    return apiResponse(500, { error: 'Erro ao atualizar voluntário' });
  }
};

// DELETE /ministries/{id}/volunteers/{volunteerId}
export const removeVolunteer = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const volunteerId = event.pathParameters?.volunteerId;
    if (!volunteerId) return apiResponse(400, { error: 'volunteerId ausente' });

    const { rows: volRows } = await query(`
      SELECT mv.id, mv.organization_id, mv.ministry_id, m.leader_id
      FROM ministry_volunteers mv
      INNER JOIN ministries m ON mv.ministry_id = m.id
      WHERE mv.id = ? LIMIT 1
    `, [volunteerId]);
    if (volRows.length === 0) return apiResponse(404, { error: 'Voluntário não encontrado' });

    const tenantCheck = enforceTenant(auth.user, volRows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    if (!canUserManageMinistry(auth.user, volRows[0])) {
      return apiResponse(403, { error: 'Acesso negado: Você só pode remover voluntários do ministério que lidera.' });
    }

    await query(`DELETE FROM ministry_volunteers WHERE id = ?`, [volunteerId]);
    return apiResponse(200, { message: 'Voluntário removido do ministério' });
  } catch (err: any) {
    return apiResponse(500, { error: 'Erro ao remover voluntário' });
  }
};

// POST / PATCH /ministries/{id}/volunteers/batch -> Ações em massa (Aprovar, Pausar, Funções, Excluir)
export const batchVolunteers = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério ausente' });

    const { rows: minRows } = await query(`SELECT organization_id, name, leader_id FROM ministries WHERE id = ? LIMIT 1`, [ministryId]);
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

    if (action === 'DELETE') {
      await query(
        `DELETE FROM ministry_volunteers WHERE ministry_id = ? AND id IN (${placeholders})`,
        [ministryId, ...volunteer_ids]
      );
      return apiResponse(200, { success: true, count: volunteer_ids.length });
    }

    if (action === 'UPDATE_STATUS' && status) {
      await query(
        `UPDATE ministry_volunteers SET status = ? WHERE ministry_id = ? AND id IN (${placeholders})`,
        [status, ministryId, ...volunteer_ids]
      );
      return apiResponse(200, { success: true, count: volunteer_ids.length });
    }

    if (action === 'UPDATE_ROLES' && roles_csv !== undefined) {
      await query(
        `UPDATE ministry_volunteers SET roles_csv = ? WHERE ministry_id = ? AND id IN (${placeholders})`,
        [roles_csv, ministryId, ...volunteer_ids]
      );
      return apiResponse(200, { success: true, count: volunteer_ids.length });
    }

    return apiResponse(400, { error: 'Ação inválida ou parâmetros ausentes' });
  } catch (err: any) {
    console.error('Erro em batchVolunteers:', err);
    return apiResponse(500, { error: 'Erro ao executar operação em massa', details: err.message });
  }
};


// GET /ministries/{id}/schedules -> Listar escalas com voluntários alocados
export const listSchedules = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;
    const roleCheck = enforceRole(auth.user, MINISTRY_VIEW_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério ausente' });

    const { rows: ministryRows } = await query(
      `SELECT id, organization_id, leader_id FROM ministries WHERE id = ? LIMIT 1`,
      [ministryId]
    );
    if (ministryRows.length === 0) return apiResponse(404, { error: 'Ministério não encontrado' });
    const ministry = ministryRows[0];
    const tenantCheck = enforceTenant(auth.user, ministry.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    if (!(await canUserViewMinistrySchedules(auth.user, ministry))) {
      return apiResponse(403, { error: 'Acesso negado: escalas disponíveis apenas para responsáveis e voluntários deste ministério.' });
    }

    const timeframe = event.queryStringParameters?.timeframe; // 'upcoming', 'past', 'all'
    const statusParam = event.queryStringParameters?.status; // 'DRAFT', 'PUBLISHED', 'COMPLETED', 'all'

    let whereSql = `WHERE ss.ministry_id = ? AND ss.organization_id = ?`;
    const params: any[] = [ministryId, tenantCheck.effectiveOrgId];

    if (timeframe === 'upcoming') {
      whereSql += ` AND (ss.service_date >= CURDATE() AND ss.status != 'COMPLETED')`;
    } else if (timeframe === 'past') {
      whereSql += ` AND (ss.service_date < CURDATE() OR ss.status = 'COMPLETED')`;
    }

    if (statusParam && statusParam !== 'all') {
      whereSql += ` AND ss.status = ?`;
      params.push(statusParam);
    }

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
      const scheduleIds = schedules.map(s => `'${s.id}'`).join(',');
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
        LEFT JOIN service_roster_swaps sw ON sw.roster_item_id = sri.id AND sw.status = 'PENDING'
        LEFT JOIN members sw_target_m ON sw.target_member_id = sw_target_m.id
        WHERE sri.schedule_id IN (${scheduleIds}) AND sri.organization_id = ?
        ORDER BY mr.name ASC, m.name ASC
      `, [tenantCheck.effectiveOrgId]);

      const fullSchedules = schedules.map(sch => ({
        ...sch,
        roster_items: items.filter(it => it.schedule_id === sch.id)
      }));

      return apiResponse(200, fullSchedules);
    }

    return apiResponse(200, []);
  } catch (err: any) {
    console.error('Erro ao listar escalas:', err);
    return apiResponse(500, { error: 'Erro ao listar escalas' });
  }
};

// POST /ministries/{id}/schedules -> Criar ou Atualizar Escala de Culto com Voluntários
export const createOrUpdateSchedule = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério ausente' });

    const { rows: minRows } = await query(`SELECT organization_id, campus_id, name, leader_id FROM ministries WHERE id = ? LIMIT 1`, [ministryId]);
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
      await query(`DELETE FROM service_roster_items WHERE schedule_id = ?`, [scheduleId]);

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
    console.error('Erro ao salvar escala:', err);
    return apiResponse(500, { error: 'Erro ao salvar escala do culto' });
  }
};

// POST /ministries/{id}/schedules/batch -> Criar múltiplas escalas em lote (Gerador do Mês)
export const createBatchSchedules = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério é obrigatório' });

    const { rows: minRows } = await query(`SELECT organization_id, campus_id, name, leader_id FROM ministries WHERE id = ? LIMIT 1`, [ministryId]);
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
        await query(`DELETE FROM service_roster_items WHERE schedule_id = ?`, [scheduleId]);
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
    console.error('Erro ao criar escalas em lote:', err);
    return apiResponse(500, { error: 'Erro ao criar escalas em lote' });
  }
};

// DELETE /ministries/{id}/schedules/{scheduleId}
export const deleteSchedule = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const scheduleId = event.pathParameters?.scheduleId;
    if (!scheduleId) return apiResponse(400, { error: 'scheduleId ausente' });

    const { rows: schRows } = await query(`
      SELECT ss.id, ss.organization_id, ss.ministry_id, m.leader_id 
      FROM service_schedules ss
      INNER JOIN ministries m ON ss.ministry_id = m.id
      WHERE ss.id = ? LIMIT 1
    `, [scheduleId]);
    if (schRows.length === 0) return apiResponse(404, { error: 'Escala não encontrada' });
    const sch = schRows[0];

    const tenantCheck = enforceTenant(auth.user, sch.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    if (!canUserManageMinistry(auth.user, sch)) {
      return apiResponse(403, { error: 'Acesso negado: Você só pode excluir escalas do ministério que lidera.' });
    }

    await query(`DELETE FROM service_roster_items WHERE schedule_id = ?`, [scheduleId]);
    await query(`DELETE FROM service_schedules WHERE id = ?`, [scheduleId]);

    return apiResponse(200, { message: 'Escala excluída com sucesso' });
  } catch (err: any) {
    return apiResponse(500, { error: 'Erro ao excluir escala' });
  }
};

// GET /volunteers/my-schedules -> Escalas do membro autenticado (PWA / Mobile)
export const getMySchedules = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const targetUserId = auth.user.userId;

    // Buscar escalas ativas futuras ou recentes para este membro
    const sql = `
      SELECT 
        sri.id as roster_item_id,
        sri.status as confirmation_status,
        sri.decline_reason,
        sri.confirmed_at,
        ss.id as schedule_id,
        ss.title as service_title,
        DATE_FORMAT(ss.service_date, '%Y-%m-%d') as service_date,
        ss.service_time,
        ss.notes as schedule_notes,
        m.name as ministry_name,
        m.color as ministry_color,
        m.icon as ministry_icon,
        mr.name as role_name
      FROM service_roster_items sri
      INNER JOIN service_schedules ss ON sri.schedule_id = ss.id
      INNER JOIN ministries m ON ss.ministry_id = m.id
      INNER JOIN ministry_roles mr ON sri.role_id = mr.id
      WHERE (sri.member_id = ? OR sri.member_id = (SELECT id FROM members WHERE email = ? LIMIT 1))
        AND ss.service_date >= DATE_SUB(CURDATE(), INTERVAL 2 DAY)
      ORDER BY ss.service_date ASC, ss.service_time ASC
    `;

    const { rows } = await query(sql, [targetUserId, auth.user.email]);
    return apiResponse(200, rows);
  } catch (err: any) {
    console.error('Erro ao consultar escalas do voluntário:', err);
    return apiResponse(500, { error: 'Erro ao buscar suas escalas' });
  }
};

// POST /volunteers/schedules/{rosterItemId}/respond -> Aceitar ou Recusar Escala
export const respondRosterItem = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const rosterItemId = event.pathParameters?.rosterItemId;
    if (!rosterItemId) return apiResponse(400, { error: 'rosterItemId ausente' });

    const body = JSON.parse(event.body || '{}');
    const { status, decline_reason } = body; // 'ACCEPTED' | 'DECLINED'

    if (!status || !['ACCEPTED', 'DECLINED'].includes(status)) {
      return apiResponse(400, { error: 'Status deve ser ACCEPTED ou DECLINED' });
    }

    await query(`
      UPDATE service_roster_items
      SET status = ?, decline_reason = ?, confirmed_at = NOW()
      WHERE id = ? AND organization_id = ? AND member_id = ?
    `, [status, decline_reason || null, rosterItemId, auth.user.organizationId, auth.user.userId]);

    return apiResponse(200, {
      message: status === 'ACCEPTED' ? '✓ Presença na escala confirmada com sucesso!' : 'Escala recusada. A liderança foi notificada.',
      status
    });
  } catch (err: any) {
    console.error('Erro ao responder escala:', err);
    return apiResponse(500, { error: 'Erro ao responder convite da escala' });
  }
};

// ==========================================
// FASE 3: AGENDA DE INDISPONIBILIDADES & CONFLITOS
// ==========================================

// GET /volunteers/blockouts
export const getMyBlockouts = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const targetUserId = auth.user.userId;
    const orgId = auth.user.organizationId || (event.queryStringParameters?.organization_id) || 'org_default';

    const sql = `
      SELECT id, member_id, start_date, end_date, reason, created_at
      FROM volunteer_blockouts
      WHERE organization_id = ?
        AND (member_id = ? OR member_id = (SELECT id FROM members WHERE email = ? LIMIT 1))
      ORDER BY start_date DESC
    `;

    const { rows } = await query(sql, [orgId, targetUserId, auth.user.email]);
    return apiResponse(200, rows);
  } catch (err: any) {
    console.error('Erro ao consultar blockouts:', err);
    return apiResponse(500, { error: 'Erro ao buscar indisponibilidades' });
  }
};

// POST /volunteers/blockouts
export const createBlockout = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const body = JSON.parse(event.body || '{}');
    const { start_date, end_date, reason } = body;

    if (!start_date || !end_date) {
      return apiResponse(400, { error: 'start_date e end_date são obrigatórios' });
    }

    const orgId = auth.user.organizationId || body.organization_id || 'org_default';

    // Resolver member_id correto
    let memberId = auth.user.userId;
    const { rows: memRows } = await query(
      `SELECT id FROM members WHERE (id = ? OR email = ?) AND organization_id = ? LIMIT 1`,
      [memberId, auth.user.email, orgId]
    );
    if (memRows.length > 0) {
      memberId = memRows[0].id;
    }

    const id = uuidv4();
    await query(`
      INSERT INTO volunteer_blockouts (id, organization_id, member_id, start_date, end_date, reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, orgId, memberId, start_date, end_date, reason || null]);

    return apiResponse(201, {
      message: 'Bloqueio de data cadastrado com sucesso',
      id,
      start_date,
      end_date,
      reason
    });
  } catch (err: any) {
    console.error('Erro ao cadastrar blockout:', err);
    return apiResponse(500, { error: 'Erro ao cadastrar indisponibilidade' });
  }
};

// DELETE /volunteers/blockouts/{id}
export const deleteBlockout = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const blockoutId = event.pathParameters?.id || event.pathParameters?.blockoutId;
    if (!blockoutId) return apiResponse(400, { error: 'ID do bloqueio ausente' });

    const orgId = auth.user.organizationId || 'org_default';

    await query(`
      DELETE FROM volunteer_blockouts 
      WHERE id = ? AND organization_id = ? AND member_id = ?
    `, [blockoutId, orgId, auth.user.userId]);

    return apiResponse(200, { message: 'Bloqueio de data cancelado com sucesso' });
  } catch (err: any) {
    console.error('Erro ao excluir blockout:', err);
    return apiResponse(500, { error: 'Erro ao remover bloqueio' });
  }
};

// GET /ministries/conflicts?date=YYYY-MM-DD (ou start_date=...&end_date=...)&schedule_id=...
export const getScheduleConflicts = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const qp = event.queryStringParameters || {};
    const startDate = qp.start_date || qp.date;
    const endDate = qp.end_date || qp.date;
    const scheduleId = qp.schedule_id || null;
    const orgId = auth.user.organizationId || qp.organization_id || 'org_default';

    if (!startDate) {
      return apiResponse(400, { error: 'Parâmetro date ou start_date é obrigatório (YYYY-MM-DD)' });
    }

    // 1. Voluntários com blockout ativo na data ou no período solicitado
    const { rows: blockouts } = await query(`
      SELECT vb.id, vb.member_id, m.name as member_name, vb.start_date, vb.end_date, vb.reason
      FROM volunteer_blockouts vb
      INNER JOIN members m ON vb.member_id = m.id
      WHERE vb.organization_id = ? 
        AND vb.start_date <= ? AND vb.end_date >= ?
    `, [orgId, endDate, startDate]);

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
      INNER JOIN service_schedules ss ON sri.schedule_id = ss.id
      INNER JOIN ministries min ON ss.ministry_id = min.id
      INNER JOIN ministry_roles mr ON sri.role_id = mr.id
      INNER JOIN members m ON sri.member_id = m.id
      WHERE ss.organization_id = ?
        AND ss.service_date >= ? AND ss.service_date <= ?
        AND (? IS NULL OR ss.id != ?)
    `, [orgId, startDate, endDate, scheduleId, scheduleId]);

    return apiResponse(200, {
      date: startDate,
      start_date: startDate,
      end_date: endDate,
      blockouts,
      doubleBookings
    });
  } catch (err: any) {
    console.error('Erro ao consultar conflitos de escala:', err);
    return apiResponse(500, { error: 'Erro ao consultar conflitos de escala' });
  }
};

// ==========================================
// FASE 5: SHIFT SWAP (TROCA DE ESCALAS) & LEMBRETES 24H
// ==========================================

// GET /volunteers/schedules/eligible-peers?schedule_id=...&role_id=...
export const getEligiblePeersForSwap = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const qp = event.queryStringParameters || {};
    const { schedule_id, role_id } = qp;
    if (!schedule_id || !role_id) {
      return apiResponse(400, { error: 'schedule_id e role_id são obrigatórios' });
    }

    const { rows: schedRows } = await query(`SELECT organization_id, service_date, service_time FROM service_schedules WHERE id = ? LIMIT 1`, [schedule_id]);
    if (schedRows.length === 0) return apiResponse(404, { error: 'Escala não encontrada' });
    const sched = schedRows[0];

    const { rows: peers } = await query(`
      SELECT DISTINCT m.id, m.name, m.email, m.phone
      FROM ministry_volunteers mv
      INNER JOIN members m ON mv.member_id = m.id
      INNER JOIN ministry_roles mr ON mr.ministry_id = mv.ministry_id
      WHERE mr.id = ?
        AND mv.status = 'ACTIVE'
        AND m.id != ?
        AND NOT EXISTS (
          SELECT 1 FROM volunteer_blockouts vb 
          WHERE vb.member_id = m.id 
            AND ? BETWEEN vb.start_date AND vb.end_date
        )
        AND NOT EXISTS (
          SELECT 1 FROM service_roster_items sri
          INNER JOIN service_schedules ss ON sri.schedule_id = ss.id
          WHERE sri.member_id = m.id 
            AND ss.service_date = ? 
            AND ss.id = ?
        )
      ORDER BY m.name ASC
    `, [role_id, auth.user.userId, sched.service_date, sched.service_date, schedule_id]);

    return apiResponse(200, peers);
  } catch (err: any) {
    console.error('Erro ao buscar pares aptos para troca:', err);
    return apiResponse(500, { error: 'Erro ao listar voluntários aptos para troca' });
  }
};

// POST /volunteers/schedules/roster/{rosterItemId}/swap
export const requestRosterSwap = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const rosterItemId = event.pathParameters?.rosterItemId;
    if (!rosterItemId) return apiResponse(400, { error: 'rosterItemId ausente' });

    const body = JSON.parse(event.body || '{}');
    const { target_member_id, reason } = body;

    const { rows: itemRows } = await query(`
      SELECT sri.id, sri.organization_id, sri.schedule_id, sri.role_id, sri.member_id,
             ss.title as service_title, ss.service_date, ss.service_time,
             m.name as requesting_member_name
      FROM service_roster_items sri
      INNER JOIN service_schedules ss ON sri.schedule_id = ss.id
      INNER JOIN members m ON sri.member_id = m.id
      WHERE sri.id = ? LIMIT 1
    `, [rosterItemId]);

    if (itemRows.length === 0) return apiResponse(404, { error: 'Item de escala não encontrado' });
    const item = itemRows[0];

    const tenantCheck = enforceTenant(auth.user, item.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    if (item.member_id !== auth.user.userId) return apiResponse(403, { error: 'Somente o voluntário escalado pode solicitar a própria troca' });
    if (target_member_id) {
      const { rows } = await query('SELECT id FROM members WHERE id = ? AND organization_id = ?', [target_member_id, tenantCheck.effectiveOrgId]);
      if (!rows.length) return apiResponse(404, { error: 'Substituto não encontrado nesta organização' });
    }
    const swapId = uuidv4();

    await query(`
      INSERT INTO service_roster_swaps 
      (id, organization_id, roster_item_id, schedule_id, role_id, requesting_member_id, target_member_id, reason, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
    `, [
      swapId,
      tenantCheck.effectiveOrgId,
      rosterItemId,
      item.schedule_id,
      item.role_id,
      item.member_id,
      target_member_id || null,
      reason || 'Motivo pessoal/imprevisto'
    ]);

    await query(`
      UPDATE service_roster_items
      SET status = 'SWAP_REQUESTED'
      WHERE id = ?
    `, [rosterItemId]);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'SERVICE_ROSTER_SWAP_REQUESTED',
      resource: 'service_roster_swaps',
      resourceId: swapId,
      details: {
        schedule_title: item.service_title,
        service_date: item.service_date,
        reason
      },
      event
    });

    return apiResponse(201, {
      message: 'Solicitação de troca enviada com sucesso!',
      swap_id: swapId
    });
  } catch (err: any) {
    console.error('Erro ao solicitar troca de escala:', err);
    return apiResponse(500, { error: 'Erro ao solicitar troca de escala' });
  }
};

// GET /volunteers/swaps/pending
export const getMyPendingSwaps = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const currentUserId = auth.user.userId;

    const { rows: incomingSwaps } = await query(`
      SELECT 
        sw.id as swap_id,
        sw.reason,
        sw.created_at,
        sw.status,
        req_m.name as requesting_member_name,
        req_m.phone as requesting_member_phone,
        ss.title as service_title,
        ss.service_date,
        ss.service_time,
        min.name as ministry_name,
        mr.name as role_name,
        sri.id as roster_item_id
      FROM service_roster_swaps sw
      INNER JOIN service_roster_items sri ON sw.roster_item_id = sri.id
      INNER JOIN service_schedules ss ON sw.schedule_id = ss.id
      INNER JOIN ministries min ON ss.ministry_id = min.id
      INNER JOIN ministry_roles mr ON sw.role_id = mr.id
      INNER JOIN members req_m ON sw.requesting_member_id = req_m.id
      WHERE sw.status = 'PENDING'
        AND sw.requesting_member_id != ?
        AND (
          sw.target_member_id = ? 
          OR (sw.target_member_id IS NULL AND EXISTS (
            SELECT 1 FROM ministry_volunteers mv 
            WHERE mv.member_id = ? AND mv.ministry_id = min.id AND mv.status = 'ACTIVE'
          ))
        )
      ORDER BY sw.created_at DESC
    `, [currentUserId, currentUserId, currentUserId]);

    const { rows: myOutgoingSwaps } = await query(`
      SELECT 
        sw.id as swap_id,
        sw.reason,
        sw.created_at,
        sw.status,
        sw.schedule_id,
        sw.roster_item_id,
        tgt_m.name as target_member_name,
        ss.title as service_title,
        ss.service_date,
        ss.service_time,
        min.name as ministry_name,
        mr.name as role_name
      FROM service_roster_swaps sw
      INNER JOIN service_schedules ss ON sw.schedule_id = ss.id
      INNER JOIN ministries min ON ss.ministry_id = min.id
      INNER JOIN ministry_roles mr ON sw.role_id = mr.id
      LEFT JOIN members tgt_m ON sw.target_member_id = tgt_m.id
      WHERE sw.requesting_member_id = ?
      ORDER BY sw.created_at DESC
    `, [currentUserId]);

    return apiResponse(200, {
      incoming: incomingSwaps,
      outgoing: myOutgoingSwaps
    });
  } catch (err: any) {
    console.error('Erro ao listar trocas de escala:', err);
    return apiResponse(500, { error: 'Erro ao listar trocas pendentes' });
  }
};

// POST /volunteers/swaps/{swapId}/respond
export const respondToSwap = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const swapId = event.pathParameters?.swapId;
    if (!swapId) return apiResponse(400, { error: 'swapId ausente' });

    const body = JSON.parse(event.body || '{}');
    const { action } = body;
    if (!action || !['ACCEPT', 'REJECT'].includes(action)) {
      return apiResponse(400, { error: 'Ação deve ser ACCEPT ou REJECT' });
    }

    const scope = enforceTenant(auth.user, event.headers?.['x-organization-id']);
    if (!scope.allowed) return scope.errorResponse!;
    const { rows: swapRows } = await query(`
      SELECT sw.*, ss.title as service_title, ss.service_date, min.name as ministry_name
      FROM service_roster_swaps sw
      INNER JOIN service_schedules ss ON sw.schedule_id = ss.id
      INNER JOIN ministries min ON ss.ministry_id = min.id
      WHERE sw.id = ? AND sw.organization_id = ? AND sw.status = 'PENDING'
      LIMIT 1
    `, [swapId, scope.effectiveOrgId]);

    if (swapRows.length === 0) {
      return apiResponse(404, { error: 'Solicitação de troca não encontrada ou já respondida' });
    }
    const swap = swapRows[0];
    const tenantCheck = enforceTenant(auth.user, swap.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    if (swap.requesting_member_id === auth.user.userId || (swap.target_member_id && swap.target_member_id !== auth.user.userId)) return apiResponse(403, { error: 'Você não é o destinatário desta troca' });
    const { rows: eligible } = await query(`SELECT mv.member_id FROM ministry_volunteers mv JOIN service_schedules ss ON ss.ministry_id = mv.ministry_id WHERE ss.id = ? AND ss.organization_id = ? AND mv.member_id = ? AND mv.status = 'ACTIVE'`, [swap.schedule_id, tenantCheck.effectiveOrgId, auth.user.userId]);
    if (!eligible.length) return apiResponse(403, { error: 'Voluntário não habilitado neste ministério' });
    const currentUserId = auth.user.userId;

    if (action === 'ACCEPT') {
      await query(`
        UPDATE service_roster_items 
        SET member_id = ?, status = 'ACCEPTED', confirmed_at = NOW()
        WHERE id = ? AND organization_id = ?
      `, [currentUserId, swap.roster_item_id, tenantCheck.effectiveOrgId]);

      await query(`
        UPDATE service_roster_swaps 
        SET status = 'ACCEPTED', target_member_id = ?, responded_at = NOW()
        WHERE id = ? AND organization_id = ?
      `, [currentUserId, swapId, tenantCheck.effectiveOrgId]);

      await logSecurityEvent({
        organizationId: swap.organization_id,
        user: auth.user,
        action: 'SERVICE_ROSTER_SWAP_ACCEPTED',
        resource: 'service_roster_swaps',
        resourceId: swapId,
        details: {
          new_member_id: currentUserId,
          previous_member_id: swap.requesting_member_id,
          schedule_title: swap.service_title
        },
        event
      });

      return apiResponse(200, {
        message: '✓ Substituição confirmada! Você foi incluído na escala do culto.'
      });
    } else {
      // Se era direcionado especificamente para o usuário, encerra e devolve para ACCEPTED
      if (swap.target_member_id === currentUserId) {
        await query(`
          UPDATE service_roster_swaps 
          SET status = 'REJECTED', responded_at = NOW()
          WHERE id = ? AND organization_id = ?
        `, [swapId, tenantCheck.effectiveOrgId]);

        await query(`
          UPDATE service_roster_items 
          SET status = 'ACCEPTED' 
          WHERE id = ? AND organization_id = ?
        `, [swap.roster_item_id, tenantCheck.effectiveOrgId]);
      }
      // Se for aberto para o grupo todo, apenas não assume sem cancelar para os demais colegas
      return apiResponse(200, {
        message: 'Você optou por não assumir esta vaga.'
      });
    }
  } catch (err: any) {
    console.error('Erro ao responder troca de escala:', err);
    return apiResponse(500, { error: 'Erro ao responder solicitação de troca' });
  }
};

// POST /volunteers/swaps/{swapId}/cancel ou POST /volunteers/swaps/cancel
export const cancelRosterSwap = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const swapId = event.pathParameters?.swapId;
    const body = event.body ? JSON.parse(event.body) : {};
    const rosterItemId = body.rosterItemId || event.pathParameters?.rosterItemId;

    let swap: any = null;
    if (swapId && swapId !== 'cancel') {
      const { rows } = await query(`SELECT * FROM service_roster_swaps WHERE id = ? LIMIT 1`, [swapId]);
      if (rows.length > 0) swap = rows[0];
    } else if (rosterItemId) {
      const { rows } = await query(`
        SELECT * FROM service_roster_swaps 
        WHERE roster_item_id = ? AND status = 'PENDING' 
        ORDER BY created_at DESC LIMIT 1
      `, [rosterItemId]);
      if (rows.length > 0) {
        swap = rows[0];
      } else {
        // Tenta buscar pelo schedule_id e requesting_member_id correspondentes ao item da escala
        const { rows: itemRows } = await query(`
          SELECT schedule_id, member_id FROM service_roster_items WHERE id = ? LIMIT 1
        `, [rosterItemId]);
        if (itemRows.length > 0) {
          const { rows: swapRowsBySchedule } = await query(`
            SELECT * FROM service_roster_swaps 
            WHERE schedule_id = ? AND requesting_member_id = ? AND status = 'PENDING'
            ORDER BY created_at DESC LIMIT 1
          `, [itemRows[0].schedule_id, itemRows[0].member_id]);
          if (swapRowsBySchedule.length > 0) {
            swap = swapRowsBySchedule[0];
          }
        }
      }
    }

    if (!swap) return apiResponse(404, { error: 'Solicitação de troca não encontrada' });
    const tenantCheck = enforceTenant(auth.user, swap.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    // Permissão: quem solicitou OU líder/pastor/admin
    const isOwner = auth.user.userId === swap.requesting_member_id;
    const isLeader = ['SUPERADMIN', 'ADMIN', 'PASTOR', 'LEADER'].includes(auth.user.role || '');

    if (!isOwner && !isLeader) {
      return apiResponse(403, { error: 'Você não tem permissão para cancelar esta solicitação de troca' });
    }

    // Cancela o swap específico e quaisquer swaps pendentes deste membro para esta escala
    await query(`
      UPDATE service_roster_swaps 
      SET status = 'CANCELLED', responded_at = NOW() 
      WHERE organization_id = ? AND (id = ? OR (schedule_id = ? AND requesting_member_id = ? AND status = 'PENDING'))
    `, [tenantCheck.effectiveOrgId, swap.id, swap.schedule_id, swap.requesting_member_id]);

    // Atualiza o item de escala para ACCEPTED
    await query(`
      UPDATE service_roster_items 
      SET status = 'ACCEPTED' 
      WHERE id = ? OR (schedule_id = ? AND member_id = ?)
    `, [swap.roster_item_id, swap.schedule_id, swap.requesting_member_id]);

    await logSecurityEvent({
      organizationId: swap.organization_id,
      user: auth.user,
      action: 'SERVICE_ROSTER_SWAP_CANCELLED',
      resource: 'service_roster_swaps',
      resourceId: swap.id,
      details: {
        cancelled_by: auth.user.userId,
        is_owner: isOwner,
        roster_item_id: swap.roster_item_id
      },
      event
    });

    return apiResponse(200, {
      message: 'Solicitação de troca cancelada com sucesso! Voluntário original mantido.'
    });
  } catch (err: any) {
    console.error('Erro ao cancelar solicitação de troca:', err);
    return apiResponse(500, { error: 'Erro ao cancelar solicitação de troca' });
  }
};

// POST /ministries/{id}/schedules/{scheduleId}/roster/{rosterItemId}/resolve-swap
export const resolveRosterSwapByLeader = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    const scheduleId = event.pathParameters?.scheduleId;
    const rosterItemId = event.pathParameters?.rosterItemId;

    if (!ministryId || !scheduleId || !rosterItemId) {
      return apiResponse(400, { error: 'Parâmetros ministryId, scheduleId e rosterItemId são obrigatórios' });
    }

    const body = JSON.parse(event.body || '{}');
    const { new_member_id, notes } = body;
    if (!new_member_id) {
      return apiResponse(400, { error: 'O novo voluntário substituto (new_member_id) é obrigatório' });
    }

    // Buscar item e schedule
    const { rows: itemRows } = await query(`
      SELECT sri.*, ss.organization_id, ss.title as service_title, m.name as current_member_name
      FROM service_roster_items sri
      INNER JOIN service_schedules ss ON sri.schedule_id = ss.id
      INNER JOIN members m ON sri.member_id = m.id
      WHERE sri.id = ? AND ss.id = ? AND ss.ministry_id = ?
      LIMIT 1
    `, [rosterItemId, scheduleId, ministryId]);

    if (itemRows.length === 0) {
      return apiResponse(404, { error: 'Item de escala não encontrado para este ministério' });
    }

    const item = itemRows[0];
    const tenantCheck = enforceTenant(auth.user, item.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    // Atualizar o item da escala com o novo membro
    await query(`
      UPDATE service_roster_items 
      SET member_id = ?, status = 'ACCEPTED', confirmed_at = NOW(), decline_reason = NULL, notes = COALESCE(?, notes)
      WHERE id = ?
    `, [new_member_id, notes || null, rosterItemId]);

    // Atualizar o swap para ACCEPTED se houver pendente
    await query(`
      UPDATE service_roster_swaps 
      SET status = 'ACCEPTED', target_member_id = ?, responded_at = NOW()
      WHERE roster_item_id = ? AND status = 'PENDING'
    `, [new_member_id, rosterItemId]);

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
    console.error('Erro ao resolver troca pelo líder:', err);
    return apiResponse(500, { error: 'Erro ao resolver troca de escala' });
  }
};

// POST /ministries/schedules/{scheduleId}/remind-volunteers
export const sendScheduleReminders = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const scheduleId = event.pathParameters?.scheduleId;
    if (!scheduleId) return apiResponse(400, { error: 'scheduleId ausente' });

    const { rows: schedRows } = await query(`
      SELECT ss.id, ss.organization_id, ss.title, ss.service_date, ss.service_time, ss.notes, min.name as ministry_name
      FROM service_schedules ss
      INNER JOIN ministries min ON ss.ministry_id = min.id
      WHERE ss.id = ? LIMIT 1
    `, [scheduleId]);

    if (schedRows.length === 0) return apiResponse(404, { error: 'Escala não encontrada' });
    const sched = schedRows[0];

    const tenantCheck = enforceTenant(auth.user, sched.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    const { rows: volunteers } = await query(`
      SELECT sri.id, sri.status, m.id as member_id, m.name, m.phone, mr.name as role_name
      FROM service_roster_items sri
      INNER JOIN members m ON sri.member_id = m.id
      INNER JOIN ministry_roles mr ON sri.role_id = mr.id
      WHERE sri.schedule_id = ? AND sri.status = 'ACCEPTED'
    `, [scheduleId]);

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
    console.error('Erro ao gerar lembretes de escala:', err);
    return apiResponse(500, { error: 'Erro ao preparar lembretes de escala' });
  }
};

// Handler consolidado para otimização do CloudFormation (ANY /ministries e ANY /volunteers)
export const ministriesHandler = async (event: any): Promise<APIGatewayProxyResult> => {
  const method = (event.requestContext?.http?.method || event.httpMethod || 'GET').toUpperCase();
  const rawPath = event.rawPath || event.path || '';

  // Suporte a CORS Preflight OPTIONS
  if (method === 'OPTIONS') {
    return apiResponse(200, { ok: true });
  }
  const auth = await requireAuth(event);
  if ('errorResponse' in auth) return auth.errorResponse;
  const tenantCheck = enforceTenant(auth.user, event.headers?.['x-organization-id'] || event.queryStringParameters?.organization_id);
  if (!tenantCheck.allowed) return tenantCheck.errorResponse!;


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

