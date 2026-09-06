import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';
import { getAuthenticatedUser, requireAuth, enforceRole, enforceTenant } from '../services/authMiddleware';
import { checkRateLimit } from '../services/rateLimiter';
import { logSecurityEvent } from '../services/auditLogService';

// GET /posts
export const getPosts = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const groupId = event.queryStringParameters?.group_id;
    const mediaOnly = event.queryStringParameters?.media_only === 'true';
    const requestedOrgId = event.queryStringParameters?.organization_id;

    const orgId = user ? enforceTenant(user, requestedOrgId).effectiveOrgId : (requestedOrgId || 'org_default');
    
    let sql = `
      SELECT p.id, p.cell_group_id, p.author_id, p.author_name, p.content_text, p.media_url, p.media_type, 
             p.reply_to_id, p.reply_to_author, p.reply_to_text, p.reactions, p.author_role, p.author_avatar, p.created_at 
      FROM board_posts p
      LEFT JOIN cell_groups cg ON cg.id = p.cell_group_id
      WHERE (cg.organization_id = ? OR p.cell_group_id IS NULL)
    `;
    const params: any[] = [orgId];

    if (groupId) {
      sql += ` AND (p.cell_group_id = ? OR p.cell_group_id IS NULL)`;
      params.push(groupId);
    }

    if (mediaOnly) {
      sql += ` AND p.media_type IN ('IMAGE', 'VIDEO')`;
    }

    sql += ` ORDER BY p.created_at ASC LIMIT 100`;

    const { rows } = await query(sql, params);

    const formatted = rows.map((p: any) => ({
      ...p,
      content: p.content_text || p.content || '',
      reactions: typeof p.reactions === 'string' ? (JSON.parse(p.reactions || '{}')) : (p.reactions || {})
    }));

    return apiResponse(200, formatted);
  } catch (error: any) {
    console.error('Error fetching posts:', error);
    return apiResponse(500, { message: 'Erro ao buscar mural' });
  }
};

// POST /posts
export const createPost = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const rateCheck = checkRateLimit(event, {
      maxRequests: 15,
      windowSeconds: 60,
      identifierPrefix: 'posts_create'
    });
    if (!rateCheck.allowed) return rateCheck.errorResponse!;

    const user = await getAuthenticatedUser(event);
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

    const finalAuthor = user?.name || author_name || 'Membro';
    const finalAuthorId = user?.userId || author_id || `usr_${Date.now()}`;
    const rawContent = content_text || content;
    const finalGroupId = cell_group_id || group_id || null;

    if (!rawContent || String(rawContent).trim() === '') {
      return apiResponse(400, { message: 'O conteúdo da publicação é obrigatório' });
    }

    // Sanitização e limitação de caracteres (Anti-Buffer / Anti-Spam)
    const finalContent = String(rawContent).trim().substring(0, 2000);

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
      user?.role || author_role || 'MEMBER',
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
        author_role: user?.role || author_role || 'MEMBER',
        author_avatar: author_avatar || null,
        created_at: new Date().toISOString()
      }
    });
  } catch (error: any) {
    console.error('Error creating post:', error);
    return apiResponse(500, { message: 'Erro ao salvar post' });
  }
};

// POST /posts/{id}/react
export const reactPost = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const rateCheck = checkRateLimit(event, {
      maxRequests: 40,
      windowSeconds: 60,
      identifierPrefix: 'posts_react'
    });
    if (!rateCheck.allowed) return rateCheck.errorResponse!;

    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID é obrigatório' });

    const user = await getAuthenticatedUser(event);
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
    const effectiveUser = user?.userId || userId || 'anonymous';

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
    return apiResponse(500, { message: 'Erro ao reagir ao post' });
  }
};

// DELETE /posts/{id}
export const deletePost = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID é obrigatório' });

    const { rows } = await query(`
      SELECT p.*, cg.organization_id, cg.leader_id 
      FROM board_posts p
      LEFT JOIN cell_groups cg ON cg.id = p.cell_group_id
      WHERE p.id = ? LIMIT 1
    `, [id]);

    if (rows.length === 0) return apiResponse(404, { message: 'Post não encontrado' });

    const post = rows[0];
    if (post.organization_id) {
      const tenantCheck = enforceTenant(auth.user, post.organization_id);
      if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    }

    const isAuthor = post.author_id === auth.user.userId;
    const isLeader = post.leader_id === auth.user.userId;
    const isLeadership = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER'].includes(auth.user.role);

    if (!isAuthor && !isLeader && !isLeadership) {
      return apiResponse(403, { message: 'Acesso negado para remover esta publicação' });
    }

    await query('DELETE FROM board_posts WHERE id = ?', [id]);

    await logSecurityEvent({
      organizationId: auth.user.organizationId,
      user: auth.user,
      action: 'DELETE_BOARD_POST',
      resource: 'board_posts',
      resourceId: id,
      details: { author_id: post.author_id, cell_group_id: post.cell_group_id },
      event
    });

    return apiResponse(200, { message: 'Deletado com sucesso' });
  } catch (error: any) {
    console.error('Error deleting post:', error);
    return apiResponse(500, { message: 'Erro ao deletar post' });
  }
};

