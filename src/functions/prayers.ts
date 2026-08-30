import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, getConnection, apiResponse } from '../db';
import { getAuthenticatedUser, enforceTenant } from '../services/authMiddleware';
import { checkRateLimit } from '../services/rateLimiter';

// GET /prayers?category=Família&user_id=123&organization_id=org_123
export const getPrayers = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const category = event.queryStringParameters?.category;
    const userId = event.queryStringParameters?.user_id || user?.userId;
    const requestedOrgId = event.queryStringParameters?.organization_id;
    const campusId = event.queryStringParameters?.campus_id;

    const orgId = user ? enforceTenant(user, requestedOrgId).effectiveOrgId : (requestedOrgId || 'org_default');
    const isPastoral = user?.role === 'PASTOR' || user?.role === 'SUPERADMIN' || user?.role === 'ADMIN';

    let sql = `
      SELECT p.*,
        ${userId ? `(SELECT COUNT(*) FROM prayer_intercessions pi WHERE pi.prayer_id = p.id AND pi.user_id = ?) as is_praying` : `0 as is_praying`}
      FROM prayers p
      WHERE (p.organization_id = ? OR p.organization_id IS NULL)
        AND p.status = 'APPROVED'
    `;
    const params: any[] = [];

    if (userId) {
      params.push(userId);
    }
    params.push(orgId);

    // Se não for pastor/admin, exibe apenas públicas ou as orações privadas do próprio autor
    if (!isPastoral) {
      if (userId) {
        sql += ` AND (p.privacy = 'PUBLIC' OR (p.privacy = 'CONFIDENTIAL' AND p.user_id = ?))`;
        params.push(userId);
      } else {
        sql += ` AND p.privacy = 'PUBLIC'`;
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

    sql += ` ORDER BY p.created_at DESC LIMIT 100`;

    const { rows } = await query(sql, params);

    const formatted = rows.map((r: any) => ({
      id: r.id,
      author: r.is_anonymous ? 'Membro Anônimo' : r.author_name,
      category: r.category,
      privacy: r.privacy,
      content: r.content,
      praying_count: Number(r.praying_count) || 0,
      is_praying: Boolean(Number(r.is_praying) > 0),
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
    const { user_id, author_name, is_anonymous, category, privacy, content, organization_id, campus_id } = body;

    if (!content || !content.trim()) {
      return apiResponse(400, { message: 'O conteúdo do pedido de oração é obrigatório.' });
    }

    const orgId = user ? enforceTenant(user, organization_id).effectiveOrgId : (organization_id || 'org_default');

    const prayerId = uuidv4();
    const finalAuthor = is_anonymous ? 'Membro Anônimo' : (author_name || user?.name || 'Membro da Igreja');
    const finalCategory = category || 'Outros';
    const finalPrivacy = privacy === 'CONFIDENTIAL' ? 'CONFIDENTIAL' : 'PUBLIC';
    const finalUserId = user_id || user?.userId || null;

    const sql = `
      INSERT INTO prayers (id, user_id, author_name, is_anonymous, category, privacy, content, praying_count, status, organization_id, campus_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'APPROVED', ?, ?)
    `;

    await query(sql, [
      prayerId,
      finalUserId,
      finalAuthor,
      is_anonymous ? 1 : 0,
      finalCategory,
      finalPrivacy,
      content.trim(),
      orgId,
      campus_id || null
    ]);

    return apiResponse(201, {
      message: 'Pedido de oração recebido com sucesso!',
      prayer: {
        id: prayerId,
        author: finalAuthor,
        category: finalCategory,
        privacy: finalPrivacy,
        content: content.trim(),
        praying_count: 0,
        is_praying: false,
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

// DELETE /prayers/{id}
export const deletePrayer = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID ausente' });

    const { rows } = await query(`SELECT user_id, organization_id FROM prayers WHERE id = ? LIMIT 1`, [id]);
    if (rows.length === 0) return apiResponse(404, { message: 'Oração não encontrada' });

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
