import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';

// GET /posts
export const getPosts = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const groupId = event.queryStringParameters?.group_id;
    const mediaOnly = event.queryStringParameters?.media_only === 'true';
    
    let sql = `
      SELECT id, cell_group_id, author_id, author_name, content_text, media_url, media_type, created_at 
      FROM board_posts
      WHERE 1=1
    `;
    const params: any[] = [];

    if (groupId) {
      sql += ` AND (cell_group_id = ? OR cell_group_id IS NULL)`;
      params.push(groupId);
    }

    if (mediaOnly) {
      sql += ` AND media_type IN ('IMAGE', 'VIDEO')`;
    }

    sql += ` ORDER BY created_at DESC LIMIT 50`;

    const { rows } = await query(sql, params);
    return apiResponse(200, rows);
  } catch (error: any) {
    console.error('Error fetching posts:', error);
    return apiResponse(500, { message: 'Erro ao buscar mural', error: error.message });
  }
};

// POST /posts
export const createPost = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { cell_group_id, group_id, author_id, author_name, content_text, content, media_url, media_type } = body;

    const finalAuthor = author_name || 'Membro';
    const finalAuthorId = author_id || `usr_${Date.now()}`;
    const finalContent = content_text || content;
    const finalGroupId = cell_group_id || group_id || null;

    if (!finalContent) {
      return apiResponse(400, { message: 'O conteúdo da publicação é obrigatório' });
    }

    const id = uuidv4();
    const q = `
      INSERT INTO board_posts (id, cell_group_id, author_id, author_name, content_text, media_url, media_type) 
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    await query(q, [
      id, 
      finalGroupId, 
      finalAuthorId, 
      finalAuthor, 
      finalContent, 
      media_url || null, 
      media_type || 'NONE'
    ]);

    return apiResponse(201, {
      message: 'Post enviado com sucesso',
      id,
      post: {
        id,
        cell_group_id: finalGroupId,
        author_id: finalAuthorId,
        author_name: finalAuthor,
        content_text: finalContent,
        media_url: media_url || null,
        media_type: media_type || 'NONE',
        created_at: new Date().toISOString()
      }
    });
  } catch (error: any) {
    console.error('Error creating post:', error);
    return apiResponse(500, { message: 'Erro ao salvar post', error: error.message });
  }
};

// DELETE /posts/{id}
export const deletePost = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID é obrigatório' });

    await query('DELETE FROM board_posts WHERE id = ?', [id]);
    return apiResponse(200, { message: 'Deletado com sucesso' });
  } catch (error: any) {
    console.error('Error deleting post:', error);
    return apiResponse(500, { message: 'Erro ao deletar post', error: error.message });
  }
};
