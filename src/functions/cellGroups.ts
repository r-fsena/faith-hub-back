import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';

// POST /cell-groups -> Criar ou Atualizar
export const createOrUpdateGroup = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { id, name, leader_id, description, address, neighborhood, meeting_day, meeting_time, whatsapp_contact, status, focus } = body;

    const finalId = id || uuidv4();

    const q = `
      INSERT INTO cell_groups (id, name, leader_id, description, address, neighborhood, meeting_day, meeting_time, whatsapp_contact, status, focus) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'ACTIVE'), COALESCE(?, '@GERAL'))
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
      focus
    ]);

    return apiResponse(id ? 200 : 201, { message: 'Célula/Grupo salva com sucesso', id: finalId });
  } catch (err: any) {
    console.error('Erro ao salvar célula:', err);
    return apiResponse(500, { error: err.message });
  }
};

// GET /cell-groups -> Listar todas as células
export const getGroups = async (_event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const q = `
      SELECT cg.*, m.name as leader_name,
        (SELECT COUNT(*) FROM members WHERE pending_cell_group_id = cg.id) as pending_count,
        (SELECT COUNT(*) FROM members WHERE cell_group_id = cg.id) as member_count
      FROM cell_groups cg 
      LEFT JOIN members m ON cg.leader_id = m.id 
      ORDER BY cg.name ASC
    `;
    const { rows } = await query(q);
    return apiResponse(200, rows);
  } catch (err: any) {
    console.error('Erro ao listar células:', err);
    return apiResponse(500, { error: err.message });
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
    return apiResponse(500, { error: err.message });
  }
};

// DELETE /cell-groups/{id}
export const deleteGroup = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID faltante' });

    // Desvincula membros antes de deletar
    await query(`UPDATE members SET cell_group_id = NULL WHERE cell_group_id = ?`, [id]);
    await query(`UPDATE members SET pending_cell_group_id = NULL WHERE pending_cell_group_id = ?`, [id]);
    await query(`DELETE FROM cell_groups WHERE id = ?`, [id]);

    return apiResponse(200, { message: 'Célula deletada com sucesso' });
  } catch (err: any) {
    return apiResponse(500, { error: err.message });
  }
};

// POST /cell-groups/{id}/evaluate-request (legado)
export const evaluateRequest = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const groupId = event.pathParameters?.id;
    if (!groupId) return apiResponse(400, { error: 'Group ID faltante' });

    const body = JSON.parse(event.body || '{}');
    const { memberId, approved } = body;
    if (!memberId) return apiResponse(400, { error: 'Member ID faltante' });

    if (approved) {
      await query(
        `UPDATE members SET cell_group_id = ?, pending_cell_group_id = NULL WHERE id = ? AND pending_cell_group_id = ?`,
        [groupId, memberId, groupId]
      );
    } else {
      await query(
        `UPDATE members SET pending_cell_group_id = NULL WHERE id = ? AND pending_cell_group_id = ?`,
        [memberId, groupId]
      );
    }

    return apiResponse(200, { message: approved ? 'Membro aprovado na célula!' : 'Solicitação negada e removida' });
  } catch (err: any) {
    return apiResponse(500, { error: err.message });
  }
};

// POST /cell-groups/{id}/join-requests/{userId} (chamado pelo Portal Web)
export const evaluateJoinRequest = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const groupId = event.pathParameters?.id;
    const userId = event.pathParameters?.userId;
    if (!groupId || !userId) return apiResponse(400, { error: 'Group ID ou User ID ausente' });

    const body = JSON.parse(event.body || '{}');
    const action = body.action; // 'approve' | 'reject'
    const isApproved = action === 'approve';

    if (isApproved) {
      await query(
        `UPDATE members SET cell_group_id = ?, pending_cell_group_id = NULL WHERE id = ?`,
        [groupId, userId]
      );
    } else {
      await query(
        `UPDATE members SET pending_cell_group_id = NULL WHERE id = ?`,
        [userId]
      );
    }

    return apiResponse(200, {
      message: isApproved ? 'Solicitação aprovada! Membro integrado ao grupo.' : 'Solicitação de entrada rejeitada.',
      userId,
      groupId,
      status: isApproved ? 'APPROVED' : 'REJECTED'
    });
  } catch (err: any) {
    return apiResponse(500, { error: err.message });
  }
};
