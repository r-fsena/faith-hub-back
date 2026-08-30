import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';

// GET /posts
export const getPosts = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const groupId = event.queryStringParameters?.group_id;
    const mediaOnly = event.queryStringParameters?.media_only === 'true';
    
    let sql = `
      SELECT id, cell_group_id, author_id, author_name, content_text, media_url, media_type, 
             reply_to_id, reply_to_author, reply_to_text, reactions, author_role, author_avatar, created_at 
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

    sql += ` ORDER BY created_at ASC LIMIT 100`;

    const { rows } = await query(sql, params);

    const formatted = rows.map((p: any) => ({
      ...p,
      content: p.content_text || p.content || '',
      reactions: typeof p.reactions === 'string' ? (JSON.parse(p.reactions || '{}')) : (p.reactions || {})
    }));

    return apiResponse(200, formatted);
  } catch (error: any) {
    console.error('Error fetching posts:', error);
    return apiResponse(500, { message: 'Erro ao buscar mural', error: error.message });
  }
};

// POST /posts
export const createPost = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { 
      cell_group_id, 
      group_id, 
      author_id, 
      author_name, 
      content_text, 
      content, 
      media_url, 
      media_type,
      reply_to_id,
      reply_to_author,
      reply_to_text,
      author_role,
      author_avatar
    } = body;

    const finalAuthor = author_name || 'Membro';
    const finalAuthorId = author_id || `usr_${Date.now()}`;
    const finalContent = content_text || content;
    const finalGroupId = cell_group_id || group_id || null;

    if (!finalContent) {
      return apiResponse(400, { message: 'O conteúdo da publicação é obrigatório' });
    }

    const id = uuidv4();
    const q = `
      INSERT INTO board_posts (
        id, cell_group_id, author_id, author_name, content_text, media_url, media_type,
        reply_to_id, reply_to_author, reply_to_text, reactions, author_role, author_avatar
      ) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const initialReactions = JSON.stringify({});

    await query(q, [
      id, 
      finalGroupId, 
      finalAuthorId, 
      finalAuthor, 
      finalContent, 
      media_url || null, 
      media_type || 'NONE',
      reply_to_id || null,
      reply_to_author || null,
      reply_to_text || null,
      initialReactions,
      author_role || 'Membro',
      author_avatar || null
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
        content: finalContent,
        media_url: media_url || null,
        media_type: media_type || 'NONE',
        reply_to_id: reply_to_id || null,
        reply_to_author: reply_to_author || null,
        reply_to_text: reply_to_text || null,
        reactions: {},
        author_role: author_role || 'Membro',
        author_avatar: author_avatar || null,
        created_at: new Date().toISOString()
      }
    });
  } catch (error: any) {
    console.error('Error creating post:', error);
    return apiResponse(500, { message: 'Erro ao salvar post', error: error.message });
  }
};

// POST /posts/{id}/react
export const reactPost = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID é obrigatório' });

    const body = JSON.parse(event.body || '{}');
    const { emoji, userId } = body;
    if (!emoji) return apiResponse(400, { message: 'Emoji é obrigatório' });

    const { rows } = await query('SELECT reactions FROM board_posts WHERE id = ? LIMIT 1', [id]);
    if (rows.length === 0) return apiResponse(404, { message: 'Post não encontrado' });

    let reactionsMap: Record<string, string[]> = {};
    try {
      const raw = rows[0].reactions;
      reactionsMap = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
    } catch {
      reactionsMap = {};
    }

    const currentUsers = Array.isArray(reactionsMap[emoji]) ? reactionsMap[emoji] : [];
    const effectiveUser = userId || 'anonymous';

    // Toggle reaction
    if (currentUsers.includes(effectiveUser)) {
      reactionsMap[emoji] = currentUsers.filter(u => u !== effectiveUser);
      if (reactionsMap[emoji].length === 0) delete reactionsMap[emoji];
    } else {
      reactionsMap[emoji] = [...currentUsers, effectiveUser];
    }

    const reactionsJson = JSON.stringify(reactionsMap);
    await query('UPDATE board_posts SET reactions = ? WHERE id = ?', [reactionsJson, id]);

    return apiResponse(200, {
      message: 'Reação atualizada',
      id,
      reactions: reactionsMap
    });
  } catch (error: any) {
    console.error('Error reacting to post:', error);
    return apiResponse(500, { message: 'Erro ao reagir ao post', error: error.message });
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
