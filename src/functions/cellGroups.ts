import { authorizeResource } from '../services/tenantResource';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';

const LEADERSHIP_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER'];

// POST /cell-groups -> Criar ou Atualizar
export const createOrUpdateGroup = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, LEADERSHIP_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const { id, name, leader_id, description, address, neighborhood, meeting_day, meeting_time, whatsapp_contact, status, focus, organization_id, campus_id, latitude, longitude } = body;

    const tenantCheck = enforceTenant(auth.user, organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgValue = tenantCheck.effectiveOrgId;
    if (id) {
      const resource = await authorizeResource({ ...event, headers: { ...event.headers, 'x-organization-id': orgValue } }, 'cell_groups', id);
      if ('errorResponse' in resource) return resource.errorResponse;
    }

    const finalId = id || uuidv4();
    const campusValue = campus_id || 'campus_sede';

    const q = `
      INSERT INTO cell_groups (id, name, leader_id, description, address, neighborhood, meeting_day, meeting_time, whatsapp_contact, status, focus, organization_id, campus_id, latitude, longitude) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'ACTIVE'), COALESCE(?, '@GERAL'), ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        name = VALUES(name),
        leader_id = VALUES(leader_id),
        description = VALUES(description), 
        address = VALUES(address),
        neighborhood = VALUES(neighborhood), 
        meeting_day = VALUES(meeting_day),
        meeting_time = VALUES(meeting_time), 
        whatsapp_contact = VALUES(whatsapp_contact),
        status = VALUES(status),
        focus = VALUES(focus),
        campus_id = VALUES(campus_id),
        latitude = VALUES(latitude),
        longitude = VALUES(longitude),
        updated_at = NOW()
    `;

    await query(q, [
      finalId,
      name,
      leader_id || null,
      description || null,
      address || null,
      neighborhood || null,
      meeting_day || null,
      meeting_time || null,
      whatsapp_contact || null,
      status,
      focus,
      orgValue,
      campusValue,
      latitude ? Number(latitude) : null,
      longitude ? Number(longitude) : null
    ]);

    await logSecurityEvent({
      organizationId: orgValue,
      user: auth.user,
      action: id ? 'UPDATE_CELL_GROUP' : 'CREATE_CELL_GROUP',
      resource: 'cell_groups',
      resourceId: finalId,
      details: { name, leader_id, focus },
      event
    });

    return apiResponse(id ? 200 : 201, { message: 'Célula/Grupo salva com sucesso', id: finalId });
  } catch (err: any) {
    console.error('Erro ao salvar célula:', err);
    return apiResponse(500, { error: 'Erro ao salvar célula' });
  }
};

// GET /cell-groups -> Listar todas as células com filtro de campus
export const getGroups = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const campusId = event.queryStringParameters?.campus_id;
    const requestedOrgId = event.queryStringParameters?.organization_id;

    const tenantScope = user ? enforceTenant(user, requestedOrgId) : null;
    if (tenantScope && !tenantScope.allowed) return tenantScope.errorResponse!;
    const orgId = tenantScope?.effectiveOrgId || (requestedOrgId || 'org_default');

    let q = `
      SELECT cg.*, m.name as leader_name, c.name as campus_name,
        (SELECT COUNT(*) FROM members WHERE pending_cell_group_id = cg.id) as pending_count,
        (SELECT COUNT(*) FROM members WHERE cell_group_id = cg.id) as member_count
      FROM cell_groups cg 
      LEFT JOIN members m ON cg.leader_id = m.id 
      LEFT JOIN campuses c ON cg.campus_id = c.id
      WHERE cg.organization_id = ?
    `;
    let params: any[] = [orgId];

    if (campusId && campusId !== 'all') {
      q += ` AND (cg.campus_id = ? OR cg.campus_id IS NULL)`;
      params.push(campusId);
    }

    q += ` ORDER BY cg.name ASC`;
    const { rows } = await query(q, params);
    return apiResponse(200, rows);
  } catch (err: any) {
    console.error('Erro ao buscar células:', err);
    return apiResponse(500, { error: 'Erro ao listar células' });
  }
};

// GET /cell-groups/{id} -> Detalhes da célula e membros pendentes
export const getGroup = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID faltante' });

    const scope = await authorizeResource(event, 'cell_groups', id);
    if ('errorResponse' in scope) return scope.errorResponse;
    const { rows } = await query(`SELECT * FROM cell_groups WHERE id = ? AND organization_id = ? LIMIT 1`, [id, scope.organizationId]);

    if (rows.length === 0) {
      return apiResponse(404, { message: 'Célula não encontrada' });
    }

    const { rows: pendingRows } = await query(
      `SELECT id, name, phone, email, created_at FROM members WHERE pending_cell_group_id = ? AND organization_id = ?`,
      [id, scope.organizationId]
    );

    const { rows: currentMembers } = await query(
      `SELECT id, name, phone, email, role FROM members WHERE cell_group_id = ? AND organization_id = ?`,
      [id, scope.organizationId]
    );

    const cellData = {
      ...rows[0],
      pending_users: pendingRows || [],
      members: currentMembers || []
    };

    return apiResponse(200, cellData);
  } catch (err: any) {
    return apiResponse(500, { error: 'Erro ao buscar detalhes da célula' });
  }
};

// DELETE /cell-groups/{id}
export const deleteGroup = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN']);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID faltante' });

    const { rows } = await query(`SELECT organization_id, name FROM cell_groups WHERE id = ? LIMIT 1`, [id]);
    if (rows.length === 0) return apiResponse(404, { message: 'Célula não encontrada' });

    const tenantCheck = enforceTenant(auth.user, rows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    await query(`UPDATE members SET cell_group_id = NULL WHERE cell_group_id = ?`, [id]);
    await query(`UPDATE members SET pending_cell_group_id = NULL WHERE pending_cell_group_id = ?`, [id]);
    await query(`DELETE FROM cell_groups WHERE id = ?`, [id]);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'DELETE_CELL_GROUP',
      resource: 'cell_groups',
      resourceId: id,
      details: { name: rows[0].name },
      event
    });

    return apiResponse(200, { message: 'Célula deletada com sucesso' });
  } catch (err: any) {
    return apiResponse(500, { error: 'Erro ao deletar célula' });
  }
};

// POST /cell-groups/{id}/evaluate-request (Compatibilidade com PWA e Mobile)
export const evaluateRequest = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, LEADERSHIP_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const groupId = event.pathParameters?.id;
    if (!groupId) return apiResponse(400, { error: 'Group ID faltante' });

    const scope = await authorizeResource(event, 'cell_groups', groupId, LEADERSHIP_ROLES);
    if ('errorResponse' in scope) return scope.errorResponse;
    const body = JSON.parse(event.body || '{}');
    const { memberId, approved, action, userId } = body;
    const targetUserId = memberId || userId;
    const isApproved = approved === true || action === 'approve' || body.status === 'APPROVED';

    if (!targetUserId) return apiResponse(400, { error: 'Identificação do membro (memberId/userId) faltante' });

    if (isApproved) {
      await query(
        `UPDATE members SET cell_group_id = ?, pending_cell_group_id = NULL WHERE organization_id = ? AND (id = ? OR LOWER(email) = LOWER(?))`,
        [groupId, scope.organizationId, targetUserId, targetUserId]
      );
    } else {
      await query(
        `UPDATE members SET pending_cell_group_id = NULL WHERE organization_id = ? AND (id = ? OR LOWER(email) = LOWER(?))`,
        [scope.organizationId, targetUserId, targetUserId]
      );
    }

    return apiResponse(200, {
      message: isApproved ? 'Solicitação aprovada! Membro integrado ao grupo.' : 'Solicitação de entrada rejeitada.',
      userId: targetUserId,
      groupId,
      status: isApproved ? 'APPROVED' : 'REJECTED'
    });
  } catch (err: any) {
    return apiResponse(500, { error: 'Erro ao avaliar solicitação de membro' });
  }
};

// POST /cell-groups/{id}/join-requests/{userId}
export const evaluateJoinRequest = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, LEADERSHIP_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const groupId = event.pathParameters?.id;
    const userId = event.pathParameters?.userId;
    if (!groupId || !userId) return apiResponse(400, { error: 'Group ID ou User ID ausente' });

    const scope = await authorizeResource(event, 'cell_groups', groupId, LEADERSHIP_ROLES);
    if ('errorResponse' in scope) return scope.errorResponse;
    const body = JSON.parse(event.body || '{}');
    const action = body.action || (body.status === 'APPROVED' ? 'approve' : 'reject');
    const isApproved = action === 'approve';

    if (isApproved) {
      await query(
        `UPDATE members SET cell_group_id = ?, pending_cell_group_id = NULL WHERE organization_id = ? AND (id = ? OR LOWER(email) = LOWER(?))`,
        [groupId, scope.organizationId, userId, userId]
      );
    } else {
      await query(
        `UPDATE members SET pending_cell_group_id = NULL WHERE organization_id = ? AND (id = ? OR LOWER(email) = LOWER(?))`,
        [scope.organizationId, userId, userId]
      );
    }

    return apiResponse(200, {
      message: isApproved ? 'Solicitação aprovada! Membro integrado ao grupo.' : 'Solicitação de entrada rejeitada.',
      userId,
      groupId,
      status: isApproved ? 'APPROVED' : 'REJECTED'
    });
  } catch (err: any) {
    return apiResponse(500, { error: 'Erro ao processar solicitação de membro' });
  }
};

// POST /cell-groups/{id}/members -> Adicionar membro existente à célula
export const addMember = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, LEADERSHIP_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const groupId = event.pathParameters?.id;
    if (!groupId) return apiResponse(400, { error: 'Group ID faltante' });

    const scope = await authorizeResource(event, 'cell_groups', groupId, LEADERSHIP_ROLES);
    if ('errorResponse' in scope) return scope.errorResponse;
    const body = JSON.parse(event.body || '{}');
    const { member_id } = body;
    if (!member_id) return apiResponse(400, { error: 'member_id faltante' });

    await query(
      `UPDATE members SET cell_group_id = ?, pending_cell_group_id = NULL WHERE id = ? AND organization_id = ?`,
      [groupId, member_id, scope.organizationId]
    );

    return apiResponse(200, { message: 'Membro adicionado à célula com sucesso' });
  } catch (err: any) {
    return apiResponse(500, { error: 'Erro ao vincular membro à célula' });
  }
};

// DELETE /cell-groups/{id}/members/{memberId} -> Remover/desvincular membro da célula
export const removeMember = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, LEADERSHIP_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const groupId = event.pathParameters?.id;
    const memberId = event.pathParameters?.memberId;
    if (!groupId || !memberId) return apiResponse(400, { error: 'IDs faltantes' });

    const scope = await authorizeResource(event, 'cell_groups', groupId, LEADERSHIP_ROLES);
    if ('errorResponse' in scope) return scope.errorResponse;
    await query(
      `UPDATE members SET cell_group_id = NULL WHERE id = ? AND organization_id = ? AND cell_group_id = ?`,
      [memberId, scope.organizationId, groupId]
    );

    return apiResponse(200, { message: 'Membro desvinculado da célula com sucesso' });
  } catch (err: any) {
    return apiResponse(500, { error: 'Erro ao remover membro da célula' });
  }
};

// POST /cell-groups/{id}/meetings -> Registrar reunião semanal e chamada da célula
export const recordMeeting = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const groupId = event.pathParameters?.id;
    if (!groupId) return apiResponse(400, { error: 'ID da célula faltante' });

    const { rows: cellRows } = await query(`SELECT organization_id, campus_id, leader_id, name FROM cell_groups WHERE id = ? LIMIT 1`, [groupId]);
    if (cellRows.length === 0) return apiResponse(404, { error: 'Célula não encontrada' });
    const cell = cellRows[0];

    const tenantCheck = enforceTenant(auth.user, cell.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const { 
      meeting_date, 
      study_topic, 
      offerings_amount = 0, 
      notes, 
      attendees = [] 
    } = body;

    if (!meeting_date) {
      return apiResponse(400, { error: 'Data da reunião é obrigatória (YYYY-MM-DD)' });
    }

    const meetingId = uuidv4();
    const effectiveCampusId = cell.campus_id || 'campus_sede';
    const leaderId = auth.user.userId || cell.leader_id || null;

    // 1. Inserir cabeçalho da reunião
    await query(
      `INSERT INTO cell_meetings (id, organization_id, campus_id, cell_group_id, leader_id, meeting_date, study_topic, offerings_amount, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        meetingId,
        tenantCheck.effectiveOrgId,
        effectiveCampusId,
        groupId,
        leaderId,
        meeting_date,
        study_topic || null,
        Number(offerings_amount) || 0,
        notes || null
      ]
    );

    // 2. Inserir participantes (membros e visitantes)
    let presentCount = 0;
    let absentCount = 0;
    let visitorCount = 0;

    for (const att of attendees) {
      const attId = uuidv4();
      const status = att.status === 'ABSENT' ? 'ABSENT' : (att.status === 'JUSTIFIED' ? 'JUSTIFIED' : 'PRESENT');
      
      if (status === 'PRESENT') presentCount++;
      else absentCount++;

      if (att.visitor_name) visitorCount++;

      await query(
        `INSERT INTO cell_meeting_attendees 
         (id, organization_id, meeting_id, member_id, visitor_name, visitor_phone, status, justification)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attId,
          tenantCheck.effectiveOrgId,
          meetingId,
          att.member_id || null,
          att.visitor_name || null,
          att.visitor_phone || null,
          status,
          att.justification || null
        ]
      );
    }

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'RECORD_CELL_MEETING',
      resource: 'cell_meetings',
      resourceId: meetingId,
      details: { 
        cell_name: cell.name, 
        meeting_date, 
        present_count: presentCount, 
        absent_count: absentCount,
        visitor_count: visitorCount
      },
      event
    });

    return apiResponse(201, {
      message: 'Reunião e chamada registradas com sucesso!',
      id: meetingId,
      present_count: presentCount,
      absent_count: absentCount,
      visitor_count: visitorCount
    });
  } catch (err: any) {
    console.error('Erro ao registrar reunião da célula:', err);
    return apiResponse(500, { error: 'Erro ao registrar chamada da célula' });
  }
};

// GET /cell-groups/{id}/meetings -> Listar histórico de reuniões da célula
export const getCellMeetings = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const groupId = event.pathParameters?.id;
    if (!groupId) return apiResponse(400, { error: 'ID da célula faltante' });

    const scope = await authorizeResource(event, 'cell_groups', groupId, LEADERSHIP_ROLES);
    if ('errorResponse' in scope) return scope.errorResponse;
    const q = `
      SELECT 
        cm.*,
        COUNT(CASE WHEN cma.status = 'PRESENT' THEN 1 END) as present_count,
        COUNT(CASE WHEN cma.status IN ('ABSENT', 'JUSTIFIED') THEN 1 END) as absent_count,
        COUNT(CASE WHEN cma.visitor_name IS NOT NULL THEN 1 END) as visitor_count
      FROM cell_meetings cm
      LEFT JOIN cell_meeting_attendees cma ON cm.id = cma.meeting_id
      WHERE cm.cell_group_id = ? AND cm.organization_id = ?
      GROUP BY cm.id
      ORDER BY cm.meeting_date DESC, cm.created_at DESC
      LIMIT 30
    `;

    const { rows } = await query(q, [groupId, scope.organizationId]);
    return apiResponse(200, rows);
  } catch (err: any) {
    console.error('Erro ao buscar histórico de reuniões:', err);
    return apiResponse(500, { error: 'Erro ao listar histórico de reuniões' });
  }
};

// GET /cell-groups/{id}/meetings/{meetingId} -> Detalhes da reunião com lista de presença
export const getCellMeetingDetails = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const groupId = event.pathParameters?.id;
    const meetingId = event.pathParameters?.meetingId;
    if (!groupId || !meetingId) return apiResponse(400, { error: 'IDs faltantes' });

    const scope = await authorizeResource(event, 'cell_groups', groupId, LEADERSHIP_ROLES);
    if ('errorResponse' in scope) return scope.errorResponse;
    const { rows: meetingRows } = await query(
      `SELECT * FROM cell_meetings WHERE id = ? AND organization_id = ? AND cell_group_id = ? LIMIT 1`,
      [meetingId, scope.organizationId, groupId]
    );

    if (meetingRows.length === 0) {
      return apiResponse(404, { error: 'Reunião não encontrada' });
    }

    const { rows: attendees } = await query(
      `SELECT 
         cma.*,
         m.name as member_name,
         m.phone as member_phone,
         m.email as member_email
       FROM cell_meeting_attendees cma
       LEFT JOIN members m ON cma.member_id = m.id
       WHERE cma.meeting_id = ? AND EXISTS (SELECT 1 FROM cell_meetings cm WHERE cm.id = cma.meeting_id AND cm.organization_id = ?)
       ORDER BY cma.status ASC, m.name ASC`,
      [meetingId, scope.organizationId]
    );

    return apiResponse(200, {
      ...meetingRows[0],
      attendees
    });
  } catch (err: any) {
    console.error('Erro ao buscar detalhes da reunião:', err);
    return apiResponse(500, { error: 'Erro ao buscar detalhes da reunião' });
  }
};

