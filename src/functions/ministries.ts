import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';

const MINISTRY_ADMIN_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER'];

// GET /ministries -> Listar Ministérios com contadores de voluntários e funções
export const listMinistries = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const requestedOrgId = event.queryStringParameters?.organization_id;
    const campusId = event.queryStringParameters?.campus_id;

    const orgId = user ? enforceTenant(user, requestedOrgId).effectiveOrgId : (requestedOrgId || 'org_default');

    let sql = `
      SELECT 
        m.*,
        (SELECT COUNT(*) FROM ministry_roles WHERE ministry_id = m.id) as roles_count,
        (SELECT COUNT(*) FROM ministry_volunteers WHERE ministry_id = m.id AND status = 'ACTIVE') as volunteers_count,
        (SELECT COUNT(*) FROM service_schedules WHERE ministry_id = m.id AND service_date >= CURDATE()) as upcoming_schedules_count
      FROM ministries m
      WHERE m.organization_id = ?
    `;

    const params: any[] = [orgId];

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

    const finalId = id || uuidv4();
    const finalSlug = slug || name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');

    const q = `
      INSERT INTO ministries (id, organization_id, campus_id, name, slug, description, icon, color, leader_id, leader_name, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        slug = VALUES(slug),
        description = VALUES(description),
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
      icon,
      color,
      leader_id || null,
      leader_name || null,
      status
    ]);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: id ? 'UPDATE_MINISTRY' : 'CREATE_MINISTRY',
      resource: 'ministries',
      resourceId: finalId,
      details: { name, slug: finalSlug },
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
    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério ausente' });

    const { rows } = await query(`SELECT * FROM ministry_roles WHERE ministry_id = ? ORDER BY name ASC`, [ministryId]);
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

    const { rows: minRows } = await query(`SELECT organization_id FROM ministries WHERE id = ? LIMIT 1`, [ministryId]);
    if (minRows.length === 0) return apiResponse(404, { error: 'Ministério não encontrado' });

    const tenantCheck = enforceTenant(auth.user, minRows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

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

    await query(`DELETE FROM ministry_roles WHERE id = ?`, [roleId]);
    return apiResponse(200, { message: 'Função removida com sucesso' });
  } catch (err: any) {
    return apiResponse(500, { error: 'Erro ao remover função' });
  }
};

// GET /ministries/{id}/volunteers -> Listar bolsão de voluntários
export const listMinistryVolunteers = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério ausente' });

    const sql = `
      SELECT 
        mv.*,
        m.name as member_name,
        m.phone as member_phone,
        m.email as member_email,
        (
          SELECT COUNT(*) 
          FROM service_roster_items sri 
          INNER JOIN service_schedules ss ON sri.schedule_id = ss.id 
          WHERE sri.member_id = mv.member_id AND ss.ministry_id = mv.ministry_id AND sri.status = 'ACCEPTED'
        ) as total_served_count,
        (
          SELECT MAX(ss.service_date)
          FROM service_roster_items sri 
          INNER JOIN service_schedules ss ON sri.schedule_id = ss.id 
          WHERE sri.member_id = mv.member_id AND ss.ministry_id = mv.ministry_id AND sri.status = 'ACCEPTED'
        ) as last_served_date
      FROM ministry_volunteers mv
      INNER JOIN members m ON mv.member_id = m.id
      WHERE mv.ministry_id = ?
      ORDER BY m.name ASC
    `;

    const { rows } = await query(sql, [ministryId]);
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

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério ausente' });

    const { rows: minRows } = await query(`SELECT organization_id, name FROM ministries WHERE id = ? LIMIT 1`, [ministryId]);
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

    if (!member_id) return apiResponse(400, { error: 'member_id é obrigatório' });

    const volId = uuidv4();
    const joinedAt = new Date().toISOString().split('T')[0];

    const q = `
      INSERT INTO ministry_volunteers (id, organization_id, ministry_id, member_id, status, preferred_service_time, roles_csv, notes, joined_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        preferred_service_time = VALUES(preferred_service_time),
        roles_csv = VALUES(roles_csv),
        notes = VALUES(notes),
        updated_at = NOW()
    `;

    await query(q, [
      volId,
      tenantCheck.effectiveOrgId,
      ministryId,
      member_id,
      status,
      preferred_service_time || null,
      roles_csv || null,
      notes || null,
      joinedAt
    ]);

    return apiResponse(201, { message: 'Voluntário vinculado ao ministério com sucesso', id: volId });
  } catch (err: any) {
    console.error('Erro ao adicionar voluntário:', err);
    return apiResponse(500, { error: 'Erro ao adicionar voluntário' });
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

    await query(`DELETE FROM ministry_volunteers WHERE id = ?`, [volunteerId]);
    return apiResponse(200, { message: 'Voluntário removido do ministério' });
  } catch (err: any) {
    return apiResponse(500, { error: 'Erro ao remover voluntário' });
  }
};

// GET /ministries/{id}/schedules -> Listar escalas com voluntários alocados
export const listSchedules = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const ministryId = event.pathParameters?.id;
    if (!ministryId) return apiResponse(400, { error: 'ID do ministério ausente' });

    // 1. Buscar escalas
    const { rows: schedules } = await query(`
      SELECT ss.*,
        COUNT(sri.id) as total_slots,
        COUNT(CASE WHEN sri.status = 'ACCEPTED' THEN 1 END) as accepted_count,
        COUNT(CASE WHEN sri.status = 'DECLINED' THEN 1 END) as declined_count,
        COUNT(CASE WHEN sri.status = 'PENDING' THEN 1 END) as pending_count
      FROM service_schedules ss
      LEFT JOIN service_roster_items sri ON ss.id = sri.schedule_id
      WHERE ss.ministry_id = ?
      GROUP BY ss.id
      ORDER BY ss.service_date DESC, ss.service_time ASC
      LIMIT 40
    `, [ministryId]);

    // 2. Buscar itens de escala detalhados
    if (schedules.length > 0) {
      const scheduleIds = schedules.map(s => `'${s.id}'`).join(',');
      const { rows: items } = await query(`
        SELECT 
          sri.*,
          mr.name as role_name,
          m.name as member_name,
          m.phone as member_phone,
          m.email as member_email
        FROM service_roster_items sri
        INNER JOIN ministry_roles mr ON sri.role_id = mr.id
        INNER JOIN members m ON sri.member_id = m.id
        WHERE sri.schedule_id IN (${scheduleIds})
        ORDER BY mr.name ASC, m.name ASC
      `);

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

    const { rows: minRows } = await query(`SELECT organization_id, campus_id, name FROM ministries WHERE id = ? LIMIT 1`, [ministryId]);
    if (minRows.length === 0) return apiResponse(404, { error: 'Ministério não encontrado' });
    const min = minRows[0];

    const tenantCheck = enforceTenant(auth.user, min.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

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
        await query(`
          INSERT INTO service_roster_items (id, organization_id, schedule_id, role_id, member_id, status)
          VALUES (?, ?, ?, ?, ?, 'PENDING')
        `, [itemId, tenantCheck.effectiveOrgId, scheduleId, item.role_id, item.member_id]);
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

// DELETE /ministries/{id}/schedules/{scheduleId}
export const deleteSchedule = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, MINISTRY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const scheduleId = event.pathParameters?.scheduleId;
    if (!scheduleId) return apiResponse(400, { error: 'scheduleId ausente' });

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
        ss.service_date,
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
      WHERE id = ?
    `, [status, decline_reason || null, rosterItemId]);

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
    let memberId = body.member_id || auth.user.userId;
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
      WHERE id = ? AND organization_id = ?
    `, [blockoutId, orgId]);

    return apiResponse(200, { message: 'Bloqueio de data cancelado com sucesso' });
  } catch (err: any) {
    console.error('Erro ao excluir blockout:', err);
    return apiResponse(500, { error: 'Erro ao remover bloqueio' });
  }
};

// GET /ministries/conflicts?date=YYYY-MM-DD&time=HH:MM&schedule_id=...
export const getScheduleConflicts = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const qp = event.queryStringParameters || {};
    const serviceDate = qp.date;
    const scheduleId = qp.schedule_id || null;
    const orgId = auth.user.organizationId || qp.organization_id || 'org_default';

    if (!serviceDate) {
      return apiResponse(400, { error: 'Parâmetro date é obrigatório (YYYY-MM-DD)' });
    }

    // 1. Voluntários com blockout ativo na data
    const { rows: blockouts } = await query(`
      SELECT vb.id, vb.member_id, m.name as member_name, vb.start_date, vb.end_date, vb.reason
      FROM volunteer_blockouts vb
      INNER JOIN members m ON vb.member_id = m.id
      WHERE vb.organization_id = ? 
        AND ? BETWEEN vb.start_date AND vb.end_date
    `, [orgId, serviceDate]);

    // 2. Voluntários já escalados em outros ministérios ou escalas no mesmo dia
    const { rows: doubleBookings } = await query(`
      SELECT 
        sri.member_id,
        m.name as member_name,
        ss.id as schedule_id,
        ss.title as service_title,
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
        AND ss.service_date = ?
        AND (? IS NULL OR ss.id != ?)
    `, [orgId, serviceDate, scheduleId, scheduleId]);

    return apiResponse(200, {
      date: serviceDate,
      blockouts,
      doubleBookings
    });
  } catch (err: any) {
    console.error('Erro ao consultar conflitos de escala:', err);
    return apiResponse(500, { error: 'Erro ao consultar conflitos de escala' });
  }
};

// Handler consolidado para otimização do CloudFormation (ANY /ministries e ANY /volunteers)
export const ministriesHandler = async (event: any): Promise<APIGatewayProxyResult> => {
  const method = (event.requestContext?.http?.method || event.httpMethod || 'GET').toUpperCase();
  const rawPath = event.rawPath || event.path || '';

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

  // 2. /volunteers/my-schedules
  if (rawPath.startsWith('/volunteers/my-schedules') && method === 'GET') {
    return getMySchedules(event);
  }

  // 3. /volunteers/schedules/{id}/respond
  if (rawPath.includes('/volunteers/schedules/') && rawPath.endsWith('/respond') && method === 'POST') {
    const parts = rawPath.split('/');
    const rosterItemId = parts[parts.indexOf('schedules') + 1];
    if (!event.pathParameters) event.pathParameters = {};
    event.pathParameters.rosterItemId = rosterItemId;
    return respondRosterItem(event);
  }

  // 4. /ministries/conflicts
  if (rawPath.includes('/ministries/conflicts') && method === 'GET') {
    return getScheduleConflicts(event);
  }

  // 5. /ministries/{id}/roles
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

  // 6. /ministries/{id}/volunteers
  if (rawPath.includes('/volunteers')) {
    const parts = rawPath.split('/');
    const minIdx = parts.indexOf('ministries');
    const minId = parts[minIdx + 1];
    if (!event.pathParameters) event.pathParameters = {};
    event.pathParameters.id = minId;

    if (parts.length > minIdx + 3) {
      event.pathParameters.volunteerId = parts[minIdx + 3];
      if (method === 'DELETE') return removeVolunteer(event);
    }
    if (method === 'GET') return listMinistryVolunteers(event);
    if (method === 'POST') return addVolunteer(event);
  }

  // 7. /ministries/{id}/schedules
  if (rawPath.includes('/schedules')) {
    const parts = rawPath.split('/');
    const minIdx = parts.indexOf('ministries');
    const minId = parts[minIdx + 1];
    if (!event.pathParameters) event.pathParameters = {};
    event.pathParameters.id = minId;

    if (parts.length > minIdx + 3) {
      event.pathParameters.scheduleId = parts[minIdx + 3];
      if (method === 'DELETE') return deleteSchedule(event);
    }
    if (method === 'GET') return listSchedules(event);
    if (method === 'POST') return createOrUpdateSchedule(event);
  }

  // 8. /ministries ou /ministries/{id}
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

