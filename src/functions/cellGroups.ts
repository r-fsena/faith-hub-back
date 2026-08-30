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
    const { id, name, leader_id, description, address, neighborhood, meeting_day, meeting_time, whatsapp_contact, status, focus, organization_id, campus_id } = body;

    const tenantCheck = enforceTenant(auth.user, organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgValue = tenantCheck.effectiveOrgId;

    const finalId = id || uuidv4();
    const campusValue = campus_id || 'campus_sede';

    const q = `
      INSERT INTO cell_groups (id, name, leader_id, description, address, neighborhood, meeting_day, meeting_time, whatsapp_contact, status, focus, organization_id, campus_id) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'ACTIVE'), COALESCE(?, '@GERAL'), ?, ?)
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
      campusValue
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

    const orgId = user ? enforceTenant(user, requestedOrgId).effectiveOrgId : (requestedOrgId || 'org_default');

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

    const { rows } = await query(`SELECT * FROM cell_groups WHERE id = ? LIMIT 1`, [id]);

    if (rows.length === 0) {
      return apiResponse(404, { message: 'Célula não encontrada' });
    }

    const { rows: pendingRows } = await query(
      `SELECT id, name, phone, email, created_at FROM members WHERE pending_cell_group_id = ?`,
      [id]
    );

    const { rows: currentMembers } = await query(
      `SELECT id, name, phone, email, role FROM members WHERE cell_group_id = ?`,
      [id]
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

    const body = JSON.parse(event.body || '{}');
    const { memberId, approved, action, userId } = body;
    const targetUserId = memberId || userId;
    const isApproved = approved === true || action === 'approve' || body.status === 'APPROVED';

    if (!targetUserId) return apiResponse(400, { error: 'Identificação do membro (memberId/userId) faltante' });

    if (isApproved) {
      await query(
        `UPDATE members SET cell_group_id = ?, pending_cell_group_id = NULL WHERE id = ? OR LOWER(email) = LOWER(?)`,
        [groupId, targetUserId, targetUserId]
      );
    } else {
      await query(
        `UPDATE members SET pending_cell_group_id = NULL WHERE id = ? OR LOWER(email) = LOWER(?)`,
        [targetUserId, targetUserId]
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

    const body = JSON.parse(event.body || '{}');
    const action = body.action || (body.status === 'APPROVED' ? 'approve' : 'reject');
    const isApproved = action === 'approve';

    if (isApproved) {
      await query(
        `UPDATE members SET cell_group_id = ?, pending_cell_group_id = NULL WHERE id = ? OR LOWER(email) = LOWER(?)`,
        [groupId, userId, userId]
      );
    } else {
      await query(
        `UPDATE members SET pending_cell_group_id = NULL WHERE id = ? OR LOWER(email) = LOWER(?)`,
        [userId, userId]
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

    const body = JSON.parse(event.body || '{}');
    const { member_id } = body;
    if (!member_id) return apiResponse(400, { error: 'member_id faltante' });

    await query(
      `UPDATE members SET cell_group_id = ?, pending_cell_group_id = NULL WHERE id = ?`,
      [groupId, member_id]
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

    await query(
      `UPDATE members SET cell_group_id = NULL WHERE id = ? AND cell_group_id = ?`,
      [memberId, groupId]
    );

    return apiResponse(200, { message: 'Membro desvinculado da célula com sucesso' });
  } catch (err: any) {
    return apiResponse(500, { error: 'Erro ao remover membro da célula' });
  }
};
