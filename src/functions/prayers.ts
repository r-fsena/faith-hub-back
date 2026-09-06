import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, getConnection, apiResponse } from '../db';
import { getAuthenticatedUser, enforceTenant, enforceRole } from '../services/authMiddleware';
import { checkRateLimit } from '../services/rateLimiter';
import { logSecurityEvent } from '../services/auditLogService';

// GET /prayers?category=Família&user_id=123&organization_id=org_123&campus_id=camp_123
export const getPrayers = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const category = event.queryStringParameters?.category;
    const userId = event.queryStringParameters?.user_id || user?.userId;
    const requestedOrgId = event.queryStringParameters?.organization_id;
    const campusId = event.queryStringParameters?.campus_id;
    const statusFilter = event.queryStringParameters?.status; // 'ALL', 'APPROVED', 'PENDING'

    const orgId = user ? enforceTenant(user, requestedOrgId).effectiveOrgId : (requestedOrgId || 'org_default');
    const isPastoral = user?.role === 'PASTOR' || user?.role === 'SUPERADMIN' || user?.role === 'ADMIN';

    let sql = `
      SELECT p.*,
        ${userId ? `(SELECT COUNT(*) FROM prayer_intercessions pi WHERE pi.prayer_id = p.id AND pi.user_id = ?) as is_praying` : `0 as is_praying`}
      FROM prayers p
      WHERE (p.organization_id = ? OR p.organization_id IS NULL)
    `;
    const params: any[] = [];

    if (userId) {
      params.push(userId);
    }
    params.push(orgId);

    // Se não for pastor/admin, exibe apenas APPROVED
    if (!isPastoral) {
      sql += ` AND p.status = 'APPROVED'`;
      if (userId) {
        sql += ` AND (p.privacy = 'PUBLIC' OR (p.privacy = 'CONFIDENTIAL' AND p.user_id = ?))`;
        params.push(userId);
      } else {
        sql += ` AND p.privacy = 'PUBLIC'`;
      }
    } else {
      // Se for pastor/admin, permite filtrar por status ou ver todos
      if (statusFilter && statusFilter !== 'ALL') {
        sql += ` AND p.status = ?`;
        params.push(statusFilter);
      }
    }

    if (campusId && campusId !== 'all') {
      sql += ` AND (p.campus_id = ? OR p.campus_id IS NULL)`;
      params.push(campusId);
    }

    if (category && category !== 'ALL') {
      sql += ` AND p.category = ?`;
      params.push(category);
    }

    sql += ` ORDER BY p.created_at DESC LIMIT 150`;

    const { rows } = await query(sql, params);

    const formatted = rows.map((r: any) => ({
      id: r.id,
      user_id: r.user_id,
      author: r.is_anonymous ? 'Membro Anônimo' : r.author_name,
      author_name: r.author_name,
      author_phone: isPastoral ? r.author_phone : null,
      is_anonymous: Boolean(r.is_anonymous),
      category: r.category,
      privacy: r.privacy,
      content: r.content,
      praying_count: Number(r.praying_count) || 0,
      is_praying: Boolean(Number(r.is_praying) > 0),
      status: r.status,
      pastoral_response: r.pastoral_response || null,
      pastoral_responded_by: r.pastoral_responded_by || null,
      pastoral_responded_at: r.pastoral_responded_at || null,
      testimony_text: r.testimony_text || null,
      testimony_at: r.testimony_at || null,
      organization_id: r.organization_id,
      campus_id: r.campus_id,
      created_at: r.created_at,
      time_ago: formatTimeAgo(new Date(r.created_at))
    }));

    return apiResponse(200, formatted);
  } catch (error: any) {
    console.error('Erro ao buscar pedidos de oração:', error);
    return apiResponse(500, { message: 'Erro ao buscar orações' });
  }
};

// POST /prayers
export const createPrayer = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    // Rate Limiting: Máximo de 10 pedidos de oração por minuto por IP
    const rateCheck = checkRateLimit(event, {
      maxRequests: 10,
      windowSeconds: 60,
      identifierPrefix: 'prayers_create'
    });
    if (!rateCheck.allowed) return rateCheck.errorResponse!;

    const user = await getAuthenticatedUser(event);
    const body = JSON.parse(event.body || '{}');
    const { user_id, author_name, author_phone, is_anonymous, category, privacy, content, organization_id, campus_id } = body;

    if (!content || !content.trim()) {
      return apiResponse(400, { message: 'O conteúdo do pedido de oração é obrigatório.' });
    }

    const orgId = user ? enforceTenant(user, organization_id).effectiveOrgId : (organization_id || 'org_default');

    const prayerId = uuidv4();
    const finalAuthor = is_anonymous ? 'Membro Anônimo' : (author_name || user?.name || 'Membro da Igreja');
    const finalCategory = category || 'Outros';
    const finalPrivacy = privacy === 'CONFIDENTIAL' ? 'CONFIDENTIAL' : 'PUBLIC';
    const finalUserId = user_id || user?.userId || null;
    const finalPhone = author_phone ? author_phone.trim() : null;

    const sql = `
      INSERT INTO prayers (
        id, user_id, author_name, author_phone, is_anonymous, 
        category, privacy, content, praying_count, status, 
        organization_id, campus_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'APPROVED', ?, ?)
    `;

    await query(sql, [
      prayerId,
      finalUserId,
      finalAuthor,
      finalPhone,
      is_anonymous ? 1 : 0,
      finalCategory,
      finalPrivacy,
      content.trim(),
      orgId,
      campus_id || null
    ]);

    // Trilha de auditoria caso seja confidencial
    if (finalPrivacy === 'CONFIDENTIAL' && user) {
      await logSecurityEvent({
        organizationId: orgId,
        campusId: campus_id || null,
        user,
        action: 'PRAYER_CONFIDENTIAL_CREATED',
        resource: 'prayers',
        resourceId: prayerId,
        event,
        status: 'SUCCESS',
        details: { prayerId, category: finalCategory }
      });
    }

    return apiResponse(201, {
      message: 'Pedido de oração recebido com sucesso!',
      prayer: {
        id: prayerId,
        user_id: finalUserId,
        author: finalAuthor,
        author_name: finalAuthor,
        is_anonymous: Boolean(is_anonymous),
        category: finalCategory,
        privacy: finalPrivacy,
        content: content.trim(),
        praying_count: 0,
        is_praying: false,
        status: 'APPROVED',
        created_at: new Date().toISOString(),
        time_ago: 'Agora mesmo'
      }
    });
  } catch (error: any) {
    console.error('Erro ao criar pedido de oração:', error);
    return apiResponse(500, { message: 'Erro ao salvar pedido de oração' });
  }
};

// POST /prayers/{id}/pray
export const prayForRequest = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const connection = await getConnection();
  try {
    const id = event.pathParameters?.id;
    if (!id) {
      connection.release();
      return apiResponse(400, { message: 'ID da oração é obrigatório' });
    }

    const body = JSON.parse(event.body || '{}');
    const user = await getAuthenticatedUser(event);
    const userId = body.user_id || user?.userId || `anon_${Date.now()}`;

    await connection.beginTransaction();

    let isNewIntercession = true;
    if (userId) {
      const [existing]: any = await connection.query(
        `SELECT id FROM prayer_intercessions WHERE prayer_id = ? AND user_id = ? LIMIT 1`,
        [id, userId]
      );
      if (existing.length > 0) {
        isNewIntercession = false;
      } else {
        await connection.query(
          `INSERT INTO prayer_intercessions (id, prayer_id, user_id) VALUES (?, ?, ?)`,
          [uuidv4(), id, userId]
        );
      }
    }

    if (isNewIntercession) {
      await connection.query(`UPDATE prayers SET praying_count = praying_count + 1 WHERE id = ?`, [id]);
    }

    const [updatedRow]: any = await connection.query(`SELECT praying_count FROM prayers WHERE id = ? LIMIT 1`, [id]);

    await connection.commit();
    connection.release();

    const newCount = updatedRow.length > 0 ? Number(updatedRow[0].praying_count) : 1;

    return apiResponse(200, {
      message: 'Amém! Sua oração foi registrada.',
      praying_count: newCount,
      is_praying: true
    });
  } catch (error: any) {
    await connection.rollback();
    connection.release();
    console.error('Erro ao registrar intercessão:', error);
    return apiResponse(500, { message: 'Erro ao registrar oração' });
  }
};

// POST /prayers/{id}/respond (Resposta Pastoral)
export const respondPrayerPastoral = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    if (!user) return apiResponse(401, { message: 'Não autenticado' });

    const roleCheck = enforceRole(user, ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER']);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID da oração é obrigatório' });

    const body = JSON.parse(event.body || '{}');
    const { pastoral_response, pastoral_name } = body;

    if (!pastoral_response || !pastoral_response.trim()) {
      return apiResponse(400, { message: 'A mensagem de resposta pastoral é obrigatória' });
    }

    const { rows } = await query(`SELECT id, organization_id, author_name FROM prayers WHERE id = ? LIMIT 1`, [id]);
    if (rows.length === 0) return apiResponse(404, { message: 'Oração não encontrada' });

    const tenantCheck = enforceTenant(user, rows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    const responderName = pastoral_name || user.name || 'Corpo Pastoral';
    const now = new Date();

    await query(
      `UPDATE prayers 
       SET pastoral_response = ?, pastoral_responded_by = ?, pastoral_responded_at = ? 
       WHERE id = ?`,
      [pastoral_response.trim(), responderName, now, id]
    );

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      campusId: null,
      user,
      action: 'PASTORAL_PRAYER_RESPONDED',
      resource: 'prayers',
      resourceId: id,
      event,
      status: 'SUCCESS',
      details: { prayerId: id, authorName: rows[0].author_name }
    });

    return apiResponse(200, {
      message: 'Resposta pastoral registrada com sucesso!',
      pastoral_response: pastoral_response.trim(),
      pastoral_responded_by: responderName,
      pastoral_responded_at: now.toISOString()
    });
  } catch (error: any) {
    console.error('Erro ao responder pastoralmente:', error);
    return apiResponse(500, { message: 'Erro ao registrar resposta pastoral' });
  }
};

// POST /prayers/{id}/testimony (Registrar Testemunho / Oração Respondida)
export const submitTestimony = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID da oração é obrigatório' });

    const body = JSON.parse(event.body || '{}');
    const { testimony_text } = body;

    if (!testimony_text || !testimony_text.trim()) {
      return apiResponse(400, { message: 'O relato do testemunho é obrigatório' });
    }

    const { rows } = await query(`SELECT id, user_id, organization_id FROM prayers WHERE id = ? LIMIT 1`, [id]);
    if (rows.length === 0) return apiResponse(404, { message: 'Oração não encontrada' });

    if (user && rows[0].organization_id) {
      const tenantCheck = enforceTenant(user, rows[0].organization_id);
      if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    }

    // Permite autor ou liderança registrar testemunho
    const isAuthor = user && user.userId === rows[0].user_id;
    const isLeadership = user && (user.role === 'PASTOR' || user.role === 'SUPERADMIN' || user.role === 'ADMIN');
    if (!isAuthor && !isLeadership && user) {
      return apiResponse(403, { message: 'Sem permissão para adicionar testemunho neste pedido' });
    }

    const now = new Date();
    await query(
      `UPDATE prayers 
       SET testimony_text = ?, testimony_at = ?, category = 'Gratidão' 
       WHERE id = ?`,
      [testimony_text.trim(), now, id]
    );

    return apiResponse(200, {
      message: 'Glória a Deus! Testemunho registrado com sucesso.',
      testimony_text: testimony_text.trim(),
      testimony_at: now.toISOString()
    });
  } catch (error: any) {
    console.error('Erro ao registrar testemunho:', error);
    return apiResponse(500, { message: 'Erro ao registrar testemunho' });
  }
};

// PATCH /prayers/{id}/status (Moderação: APPROVED, PENDING, ARCHIVED)
export const updatePrayerStatus = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    if (!user) return apiResponse(401, { message: 'Não autenticado' });

    const roleCheck = enforceRole(user, ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER']);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const id = event.pathParameters?.id;
    const body = JSON.parse(event.body || '{}');
    const { status } = body;

    if (!['APPROVED', 'PENDING', 'ARCHIVED'].includes(status)) {
      return apiResponse(400, { message: 'Status inválido' });
    }

    const { rows } = await query(`SELECT id, organization_id FROM prayers WHERE id = ? LIMIT 1`, [id]);
    if (rows.length === 0) return apiResponse(404, { message: 'Oração não encontrada' });

    const tenantCheck = enforceTenant(user, rows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    await query(`UPDATE prayers SET status = ? WHERE id = ?`, [status, id]);

    return apiResponse(200, { message: `Status da oração atualizado para ${status}` });
  } catch (error: any) {
    return apiResponse(500, { message: 'Erro ao atualizar status' });
  }
};

// DELETE /prayers/{id}
export const deletePrayer = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID ausente' });

    const { rows } = await query(`SELECT user_id, organization_id FROM prayers WHERE id = ? LIMIT 1`, [id]);
    if (rows.length === 0) return apiResponse(404, { message: 'Oração não encontrada' });

    if (user && rows[0].organization_id) {
      const tenantCheck = enforceTenant(user, rows[0].organization_id);
      if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    }

    const isAuthor = user && user.userId === rows[0].user_id;
    const isLeadership = user && (user.role === 'PASTOR' || user.role === 'SUPERADMIN' || user.role === 'ADMIN');

    if (!isAuthor && !isLeadership) {
      return apiResponse(403, { message: 'Você não tem permissão para excluir este pedido de oração.' });
    }

    await query(`DELETE FROM prayers WHERE id = ?`, [id]);
    return apiResponse(200, { message: 'Pedido de oração removido com sucesso' });
  } catch (error: any) {
    return apiResponse(500, { message: 'Erro ao remover oração' });
  }
};

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'Agora mesmo';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Há ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Ontem';
  return `Há ${days} dias`;
}

