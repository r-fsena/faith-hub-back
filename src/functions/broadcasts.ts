import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';

// POST /broadcasts
export const createOrUpdateBroadcast = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { id, title, description, observation, youtube_url, is_available, scheduled_for } = body;

    const finalId = id || uuidv4();
    const q = `
      INSERT INTO broadcasts (id, title, description, observation, youtube_url, is_available, scheduled_for) 
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        title = VALUES(title),
        description = VALUES(description),
        observation = VALUES(observation),
        youtube_url = VALUES(youtube_url),
        is_available = VALUES(is_available),
        scheduled_for = VALUES(scheduled_for),
        updated_at = NOW()
    `;

    await query(q, [
      finalId,
      title,
      description || null,
      observation || null,
      youtube_url,
      is_available ? 1 : 0,
      scheduled_for || null
    ]);

    return apiResponse(id ? 200 : 201, { message: 'Transmissão salva com sucesso', id: finalId });
  } catch (err: any) {
    console.error('Erro ao salvar broadcast:', err);
    return apiResponse(500, { error: err.message });
  }
};

// GET /broadcasts
export const getBroadcasts = async (_event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const { rows } = await query(`SELECT * FROM broadcasts ORDER BY scheduled_for ASC, created_at DESC`);
    return apiResponse(200, rows);
  } catch (err: any) {
    console.error('Erro ao listar broadcasts:', err);
    return apiResponse(500, { error: err.message });
  }
};

// GET /broadcasts/active
export const getActiveBroadcast = async (_event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    // Pega a transmissão disponível mais recente (ignorando a default)
    const { rows } = await query(
      `SELECT * FROM broadcasts WHERE is_available = 1 AND id != 'default' ORDER BY updated_at DESC LIMIT 1`
    );

    if (rows.length > 0) {
      return apiResponse(200, rows[0]);
    }

    // Se não tem nenhuma no ar, retorna a padrão se configurada
    const { rows: defRows } = await query(`SELECT * FROM broadcasts WHERE id = 'default' LIMIT 1`);

    if (defRows.length > 0) {
      return apiResponse(200, defRows[0]);
    }

    return apiResponse(404, { message: 'Nenhuma transmissão ativa no momento' });
  } catch (err: any) {
    console.error('Erro ao buscar active broadcast:', err);
    return apiResponse(500, { error: err.message });
  }
};

// DELETE /broadcasts/{id}
export const deleteBroadcast = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID faltante' });

    await query(`DELETE FROM broadcasts WHERE id = ?`, [id]);
    return apiResponse(200, { message: 'Transmissão deletada com sucesso' });
  } catch (err: any) {
    return apiResponse(500, { error: err.message });
  }
};
