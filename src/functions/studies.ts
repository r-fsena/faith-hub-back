import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';

// POST /studies
export const createOrUpdateStudy = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { id, title, description, content_type, link, date_published, status, target_group_id, content_text } = body;

    const finalId = id || uuidv4();

    const q = `
      INSERT INTO studies (id, title, description, content_type, link, date_published, status, target_group_id, content_text) 
      VALUES (?, ?, ?, COALESCE(?, 'TEXT'), ?, ?, COALESCE(?, 'ACTIVE'), ?, ?)
      ON DUPLICATE KEY UPDATE 
        title = VALUES(title),
        description = VALUES(description),
        content_type = VALUES(content_type), 
        link = VALUES(link),
        date_published = VALUES(date_published),
        status = VALUES(status),
        target_group_id = VALUES(target_group_id),
        content_text = VALUES(content_text),
        updated_at = NOW()
    `;

    await query(q, [
      finalId,
      title,
      description || null,
      content_type,
      link || null,
      date_published || null,
      status,
      target_group_id || null,
      content_text || null
    ]);

    return apiResponse(id ? 200 : 201, { message: 'Estudo salvo com sucesso', id: finalId });
  } catch (err: any) {
    console.error('Erro ao salvar estudo:', err);
    return apiResponse(500, { error: err.message });
  }
};

// GET /studies
export const getStudies = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const groupId = event.queryStringParameters?.group_id;
    let q = `
      SELECT s.*, cg.name as target_group_name 
      FROM studies s 
      LEFT JOIN cell_groups cg ON s.target_group_id = cg.id 
    `;
    let params: any[] = [];

    if (groupId) {
      q += ` WHERE (s.target_group_id IS NULL OR s.target_group_id = ?) AND s.status = 'ACTIVE'`;
      params.push(groupId);
    }

    q += ` ORDER BY s.date_published DESC, s.created_at DESC`;

    const { rows } = await query(q, params);
    return apiResponse(200, rows);
  } catch (err: any) {
    console.error('Erro ao listar estudos:', err);
    return apiResponse(500, { error: err.message });
  }
};

// DELETE /studies/{id}
export const deleteStudy = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID faltante' });

    await query(`DELETE FROM studies WHERE id = ?`, [id]);
    return apiResponse(200, { message: 'Estudo deletado com sucesso' });
  } catch (err: any) {
    return apiResponse(500, { error: err.message });
  }
};
