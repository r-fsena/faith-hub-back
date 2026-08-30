import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';

const STUDY_ADMIN_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER'];

// POST /studies
export const createOrUpdateStudy = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, STUDY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const { id, title, description, content_type, link, date_published, status, target_group_id, content_text, organization_id, campus_id } = body;

    const tenantCheck = enforceTenant(auth.user, organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgValue = tenantCheck.effectiveOrgId;

    const finalId = id || uuidv4();
    const campusValue = campus_id || 'campus_sede';

    const q = `
      INSERT INTO studies (id, title, description, content_type, link, date_published, status, target_group_id, content_text, organization_id, campus_id) 
      VALUES (?, ?, ?, COALESCE(?, 'TEXT'), ?, ?, COALESCE(?, 'ACTIVE'), ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        title = VALUES(title),
        description = VALUES(description),
        content_type = VALUES(content_type), 
        link = VALUES(link),
        date_published = VALUES(date_published),
        status = VALUES(status),
        target_group_id = VALUES(target_group_id),
        content_text = VALUES(content_text),
        campus_id = VALUES(campus_id),
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
      content_text || null,
      orgValue,
      campusValue
    ]);

    await logSecurityEvent({
      organizationId: orgValue,
      user: auth.user,
      action: id ? 'UPDATE_STUDY' : 'CREATE_STUDY',
      resource: 'studies',
      resourceId: finalId,
      details: { title, target_group_id },
      event
    });

    return apiResponse(id ? 200 : 201, { message: 'Estudo salvo com sucesso', id: finalId });
  } catch (err: any) {
    console.error('Erro ao salvar estudo:', err);
    return apiResponse(500, { error: 'Erro ao salvar estudo' });
  }
};

// GET /studies
export const getStudies = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const groupId = event.queryStringParameters?.group_id;
    const requestedOrgId = event.queryStringParameters?.organization_id;
    const campusId = event.queryStringParameters?.campus_id;

    const orgId = user ? enforceTenant(user, requestedOrgId).effectiveOrgId : (requestedOrgId || 'org_default');

    let q = `
      SELECT s.*, cg.name as target_group_name 
      FROM studies s 
      LEFT JOIN cell_groups cg ON s.target_group_id = cg.id 
      WHERE (s.organization_id = ? OR s.organization_id IS NULL)
    `;
    let params: any[] = [orgId];

    if (campusId && campusId !== 'all') {
      q += ` AND (s.campus_id = ? OR s.campus_id IS NULL)`;
      params.push(campusId);
    }

    if (groupId) {
      q += ` AND (s.target_group_id IS NULL OR s.target_group_id = ?) AND s.status = 'ACTIVE'`;
      params.push(groupId);
    }

    q += ` ORDER BY s.date_published DESC, s.created_at DESC`;

    const { rows } = await query(q, params);
    return apiResponse(200, rows);
  } catch (err: any) {
    console.error('Erro ao listar estudos:', err);
    return apiResponse(500, { error: 'Erro ao listar estudos' });
  }
};

// DELETE /studies/{id}
export const deleteStudy = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN']);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID faltante' });

    const { rows } = await query(`SELECT organization_id, title FROM studies WHERE id = ? LIMIT 1`, [id]);
    if (rows.length === 0) return apiResponse(404, { message: 'Estudo não encontrado' });

    const tenantCheck = enforceTenant(auth.user, rows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    await query(`DELETE FROM studies WHERE id = ?`, [id]);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'DELETE_STUDY',
      resource: 'studies',
      resourceId: id,
      details: { title: rows[0].title },
      event
    });

    return apiResponse(200, { message: 'Estudo deletado com sucesso' });
  } catch (err: any) {
    return apiResponse(500, { error: 'Erro ao deletar estudo' });
  }
};
