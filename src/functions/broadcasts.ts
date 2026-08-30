import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';

const BROADCAST_ADMIN_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER'];

// POST /broadcasts
export const createOrUpdateBroadcast = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, BROADCAST_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const { id, title, description, observation, youtube_url, is_available, scheduled_for, organization_id, campus_id } = body;

    const tenantCheck = enforceTenant(auth.user, organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgValue = tenantCheck.effectiveOrgId;

    const finalId = id || uuidv4();
    const campusValue = campus_id || 'campus_sede';

    const q = `
      INSERT INTO broadcasts (id, title, description, observation, youtube_url, is_available, scheduled_for, organization_id, campus_id) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        title = VALUES(title),
        description = VALUES(description),
        observation = VALUES(observation),
        youtube_url = VALUES(youtube_url),
        is_available = VALUES(is_available),
        scheduled_for = VALUES(scheduled_for),
        campus_id = VALUES(campus_id),
        updated_at = NOW()
    `;

    await query(q, [
      finalId,
      title,
      description || null,
      observation || null,
      youtube_url,
      is_available ? 1 : 0,
      scheduled_for || null,
      orgValue,
      campusValue
    ]);

    await logSecurityEvent({
      organizationId: orgValue,
      user: auth.user,
      action: id ? 'UPDATE_BROADCAST' : 'CREATE_BROADCAST',
      resource: 'broadcasts',
      resourceId: finalId,
      details: { title, youtube_url },
      event
    });

    return apiResponse(id ? 200 : 201, { message: 'Transmissão salva com sucesso', id: finalId });
  } catch (err: any) {
    console.error('Erro ao salvar broadcast:', err);
    return apiResponse(500, { error: 'Erro ao salvar transmissão' });
  }
};

// GET /broadcasts
export const getBroadcasts = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const requestedOrgId = event.queryStringParameters?.organization_id;
    const campusId = event.queryStringParameters?.campus_id;

    const orgId = user ? enforceTenant(user, requestedOrgId).effectiveOrgId : (requestedOrgId || 'org_default');

    let sql = `SELECT * FROM broadcasts WHERE organization_id = ?`;
    const params: any[] = [orgId];

    if (campusId && campusId !== 'all') {
      sql += ` AND (campus_id = ? OR campus_id IS NULL)`;
      params.push(campusId);
    }

    sql += ` ORDER BY scheduled_for ASC, created_at DESC`;

    const { rows } = await query(sql, params);
    return apiResponse(200, rows);
  } catch (err: any) {
    console.error('Erro ao listar broadcasts:', err);
    return apiResponse(500, { error: 'Erro ao listar transmissões' });
  }
};

// GET /broadcasts/active
export const getActiveBroadcast = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const requestedOrgId = event.queryStringParameters?.organization_id;
    const campusId = event.queryStringParameters?.campus_id;

    const orgId = user ? enforceTenant(user, requestedOrgId).effectiveOrgId : (requestedOrgId || 'org_default');

    let sql = `SELECT * FROM broadcasts WHERE organization_id = ? AND is_available = 1 AND id != 'default'`;
    const params: any[] = [orgId];

    if (campusId && campusId !== 'all') {
      sql += ` AND (campus_id = ? OR campus_id IS NULL)`;
      params.push(campusId);
    }

    sql += ` ORDER BY updated_at DESC LIMIT 1`;

    const { rows } = await query(sql, params);

    if (rows.length > 0) {
      return apiResponse(200, rows[0]);
    }

    const { rows: defRows } = await query(
      `SELECT * FROM broadcasts WHERE (organization_id = ? OR organization_id = 'org_default') AND id = 'default' LIMIT 1`,
      [orgId]
    );

    if (defRows.length > 0) {
      return apiResponse(200, defRows[0]);
    }

    return apiResponse(404, { message: 'Nenhuma transmissão ativa no momento' });
  } catch (err: any) {
    console.error('Erro ao buscar active broadcast:', err);
    return apiResponse(500, { error: 'Erro ao buscar transmissão ativa' });
  }
};

// DELETE /broadcasts/{id}
export const deleteBroadcast = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN']);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID faltante' });

    const { rows } = await query(`SELECT organization_id, title FROM broadcasts WHERE id = ? LIMIT 1`, [id]);
    if (rows.length === 0) return apiResponse(404, { message: 'Transmissão não encontrada' });

    const tenantCheck = enforceTenant(auth.user, rows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    await query(`DELETE FROM broadcasts WHERE id = ?`, [id]);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'DELETE_BROADCAST',
      resource: 'broadcasts',
      resourceId: id,
      details: { title: rows[0].title },
      event
    });

    return apiResponse(200, { message: 'Transmissão deletada com sucesso' });
  } catch (err: any) {
    return apiResponse(500, { error: 'Erro ao deletar transmissão' });
  }
};
