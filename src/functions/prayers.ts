import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, getConnection, apiResponse } from '../db';

// GET /prayers?category=Família&user_id=123
export const getPrayers = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const category = event.queryStringParameters?.category;
    const userId = event.queryStringParameters?.user_id;

    let sql = `
      SELECT p.*,
        ${userId ? `(SELECT COUNT(*) FROM prayer_intercessions pi WHERE pi.prayer_id = p.id AND pi.user_id = ?) as is_praying` : `0 as is_praying`}
      FROM prayers p
      WHERE p.status = 'APPROVED' AND p.privacy = 'PUBLIC'
    `;
    const params: any[] = [];

    if (userId) {
      params.push(userId);
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
    return apiResponse(500, { message: 'Erro ao buscar orações', error: error.message });
  }
};

// POST /prayers
export const createPrayer = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { user_id, author_name, is_anonymous, category, privacy, content } = body;

    if (!content || !content.trim()) {
      return apiResponse(400, { message: 'O conteúdo do pedido de oração é obrigatório.' });
    }

    const prayerId = uuidv4();
    const finalAuthor = is_anonymous ? 'Membro Anônimo' : (author_name || 'Membro da Igreja');
    const finalCategory = category || 'Outros';
    const finalPrivacy = privacy === 'CONFIDENTIAL' ? 'CONFIDENTIAL' : 'PUBLIC';

    const sql = `
      INSERT INTO prayers (id, user_id, author_name, is_anonymous, category, privacy, content, praying_count, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'APPROVED')
    `;

    await query(sql, [
      prayerId,
      user_id || null,
      finalAuthor,
      is_anonymous ? 1 : 0,
      finalCategory,
      finalPrivacy,
      content.trim()
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
    return apiResponse(500, { message: 'Erro ao salvar pedido de oração', error: error.message });
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
    const userId = body.user_id || `anon_${Date.now()}`;

    await connection.beginTransaction();

    // Registra intercessão
    let isNewIntercession = true;
    if (body.user_id) {
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
    return apiResponse(500, { message: 'Erro ao registrar oração', error: error.message });
  }
};

// DELETE /prayers/{id}
export const deletePrayer = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID ausente' });

    await query(`DELETE FROM prayers WHERE id = ?`, [id]);
    return apiResponse(200, { message: 'Pedido de oração removido com sucesso' });
  } catch (error: any) {
    return apiResponse(500, { message: 'Erro ao remover oração', error: error.message });
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
