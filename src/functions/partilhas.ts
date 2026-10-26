import { authorizeResource } from '../services/tenantResource';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';
import { getAuthenticatedUser, requireAuth, enforceRole, enforceTenant } from '../services/authMiddleware';
import { checkRateLimit } from '../services/rateLimiter';
import { logSecurityEvent } from '../services/auditLogService';

// GET /partilhas?group_id=...
export const getPartilhas = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;
    const user = auth.user;
    const groupId = event.queryStringParameters?.group_id;
    const requestedOrgId = event.queryStringParameters?.organization_id;

    const tenantScope = user ? enforceTenant(user, requestedOrgId) : null;
    if (tenantScope && !tenantScope.allowed) return tenantScope.errorResponse!;
    const orgId = tenantScope?.effectiveOrgId || (requestedOrgId || 'org_default');

    let sql = `
      SELECT p.* 
      FROM cell_partilhas p
      INNER JOIN cell_groups cg ON cg.id = p.cell_group_id
      WHERE cg.organization_id = ?
    `;
    const params: any[] = [orgId];

    if (groupId) {
      sql += ` AND p.cell_group_id = ?`;
      params.push(groupId);
    }

    sql += ` ORDER BY p.event_date >= CURDATE() DESC, p.event_date ASC, p.created_at DESC LIMIT 100`;

    const { rows } = await query(sql, params);
    return apiResponse(200, rows);
  } catch (error: any) {
    console.error('Erro ao buscar partilhas:', error);
    return apiResponse(500, { message: 'Erro ao buscar partilhas' });
  }
};

// POST /partilhas
export const createPartilha = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const rateCheck = checkRateLimit(event, {
      maxRequests: 20,
      windowSeconds: 60,
      identifierPrefix: 'partilhas_create'
    });
    if (!rateCheck.allowed) return rateCheck.errorResponse!;

    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;
    const user = auth.user;
    const body = JSON.parse(event.body || '{}');
    const { cell_group_id, group_id, user_id, user_name, item_name, quantity, event_date } = body;

    const finalGroupId = cell_group_id || group_id;
    const scope = await authorizeResource(event, 'cell_groups', finalGroupId);
    if ('errorResponse' in scope) return scope.errorResponse;
    const finalUserId = user?.userId || user_id || `usr_${Date.now()}`;
    const finalUserName = user?.name || user_name || 'Voluntário';

    if (!finalGroupId || !item_name || !event_date) {
      return apiResponse(400, { message: 'Campos obrigatórios faltando (group_id, item_name, event_date)' });
    }

    // Sanitização de entradas
    const cleanItem = String(item_name).trim().substring(0, 150);
    const cleanQty = String(quantity || '').trim().substring(0, 60);

    const id = uuidv4();
    const q = `
      INSERT INTO cell_partilhas (id, cell_group_id, user_id, user_name, item_name, quantity, event_date, is_confirmed) 
      VALUES (?, ?, ?, ?, ?, ?, ?, false)
    `;

    await query(q, [id, finalGroupId, finalUserId, finalUserName, cleanItem, cleanQty, event_date]);

    return apiResponse(201, {
      message: 'Partilha registrada com sucesso',
      id,
      partilha: {
        id,
        cell_group_id: finalGroupId,
        user_id: finalUserId,
        user_name: finalUserName,
        item_name: cleanItem,
        quantity: cleanQty,
        event_date,
        is_confirmed: false
      }
    });
  } catch (error: any) {
    console.error('Erro ao registrar partilha:', error);
    return apiResponse(500, { message: 'Erro ao salvar partilha' });
  }
};

// PUT /partilhas/{id}/toggle
export const togglePartilha = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const rateCheck = checkRateLimit(event, {
      maxRequests: 30,
      windowSeconds: 60,
      identifierPrefix: 'partilhas_toggle'
    });
    if (!rateCheck.allowed) return rateCheck.errorResponse!;

    const id = event.pathParameters?.id;
    const body = JSON.parse(event.body || '{}');
    const { is_confirmed, user_name, user_id } = body;

    if (!id) return apiResponse(400, { message: 'ID é obrigatório' });

    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;
    const user = auth.user;
    const scope = await authorizeResource(event, 'cell_partilhas', id);
    if ('errorResponse' in scope) return scope.errorResponse;
    if (scope.record.user_id !== user.userId && !user.isSuperAdmin && !['PASTOR', 'ADMIN', 'LEADER'].includes(user.role)) return apiResponse(403, { message: 'Acesso restrito ao responsável' });
    const effectiveUserId = user.userId;
    const effectiveUserName = user?.name || user_name;

    let q = 'UPDATE cell_partilhas p JOIN cell_groups cg ON cg.id = p.cell_group_id SET p.is_confirmed = ?';
    const params: any[] = [is_confirmed === true];

    if (effectiveUserName !== undefined) {
      q += ', p.user_name = ?';
      params.push(String(effectiveUserName).trim().substring(0, 100));
    }
    if (effectiveUserId !== undefined) {
      q += ', p.user_id = ?';
      params.push(effectiveUserId);
    }

    q += ' WHERE p.id = ? AND cg.organization_id = ?';
    params.push(id, scope.organizationId);

    await query(q, params);

    return apiResponse(200, { message: 'Status alterado com sucesso', id });
  } catch (error: any) {
    console.error('Erro ao alternar status da partilha:', error);
    return apiResponse(500, { message: 'Erro ao alternar status' });
  }
};

// DELETE /partilhas/{id}
export const deletePartilha = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID é obrigatório' });

    // Busca dados da partilha e organização para garantir Anti-BOLA
    const { rows } = await query(`
      SELECT p.*, cg.organization_id, cg.leader_id 
      FROM cell_partilhas p
      INNER JOIN cell_groups cg ON cg.id = p.cell_group_id
      WHERE p.id = ? LIMIT 1
    `, [id]);

    if (rows.length === 0) return apiResponse(404, { message: 'Item não encontrado' });

    const item = rows[0];
    const tenantCheck = enforceTenant(auth.user, item.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    // Apenas o autor, o líder da célula ou administradores podem excluir o item
    const isAuthor = item.user_id === auth.user.userId;
    const isLeader = item.leader_id === auth.user.userId;
    const isLeadership = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER'].includes(auth.user.role);

    if (!isAuthor && !isLeader && !isLeadership) {
      return apiResponse(403, { message: 'Acesso negado para excluir este item' });
    }

    await query('DELETE FROM cell_partilhas WHERE id = ?', [id]);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'DELETE_CELL_PARTILHA',
      resource: 'cell_partilhas',
      resourceId: id,
      details: { item_name: item.item_name, cell_group_id: item.cell_group_id },
      event
    });

    return apiResponse(200, { message: 'Removido com sucesso' });
  } catch (error: any) {
    return apiResponse(500, { message: 'Erro ao remover partilha' });
  }
};

