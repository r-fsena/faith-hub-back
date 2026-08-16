import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';

// GET /partilhas?group_id=...
export const getPartilhas = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const groupId = event.queryStringParameters?.group_id;
    let sql = `SELECT * FROM cell_partilhas WHERE 1=1`;
    const params: any[] = [];

    if (groupId) {
      sql += ` AND cell_group_id = ?`;
      params.push(groupId);
    }

    sql += ` ORDER BY event_date >= CURDATE() DESC, event_date ASC, created_at DESC LIMIT 100`;

    const { rows } = await query(sql, params);
    return apiResponse(200, rows);
  } catch (error: any) {
    console.error('Erro ao buscar partilhas:', error);
    return apiResponse(500, { message: 'Erro ao buscar partilhas', error: error.message });
  }
};

// POST /partilhas
export const createPartilha = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { cell_group_id, group_id, user_id, user_name, item_name, quantity, event_date } = body;

    const finalGroupId = cell_group_id || group_id;
    const finalUserId = user_id || `usr_${Date.now()}`;
    const finalUserName = user_name || 'Voluntário';

    if (!finalGroupId || !item_name || !event_date) {
      return apiResponse(400, { message: 'Campos obrigatórios faltando (group_id, item_name, event_date)' });
    }

    const id = uuidv4();
    const q = `
      INSERT INTO cell_partilhas (id, cell_group_id, user_id, user_name, item_name, quantity, event_date, is_confirmed) 
      VALUES (?, ?, ?, ?, ?, ?, ?, false)
    `;

    await query(q, [id, finalGroupId, finalUserId, finalUserName, item_name, quantity || '', event_date]);

    return apiResponse(201, {
      message: 'Partilha registrada com sucesso',
      id,
      partilha: {
        id,
        cell_group_id: finalGroupId,
        user_id: finalUserId,
        user_name: finalUserName,
        item_name,
        quantity: quantity || '',
        event_date,
        is_confirmed: false
      }
    });
  } catch (error: any) {
    console.error('Erro ao registrar partilha:', error);
    return apiResponse(500, { message: 'Erro ao salvar partilha', error: error.message });
  }
};

// PUT /partilhas/{id}/toggle
export const togglePartilha = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    const body = JSON.parse(event.body || '{}');
    const { is_confirmed } = body;

    if (!id) return apiResponse(400, { message: 'ID é obrigatório' });

    await query('UPDATE cell_partilhas SET is_confirmed = ? WHERE id = ?', [is_confirmed === true, id]);

    return apiResponse(200, { message: 'Status alterado com sucesso', id });
  } catch (error: any) {
    console.error('Erro ao alternar status da partilha:', error);
    return apiResponse(500, { message: 'Erro ao alternar status', error: error.message });
  }
};

// DELETE /partilhas/{id}
export const deletePartilha = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID é obrigatório' });

    await query('DELETE FROM cell_partilhas WHERE id = ?', [id]);
    return apiResponse(200, { message: 'Removido com sucesso' });
  } catch (error: any) {
    return apiResponse(500, { message: 'Erro ao remover partilha', error: error.message });
  }
};
