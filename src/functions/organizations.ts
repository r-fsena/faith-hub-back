import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';

// GET /organizations
export const listOrganizations = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    // Se for SuperAdmin, lista todas as igrejas da plataforma. Se for usuário comum, retorna apenas a sua própria organização.
    if (auth.user.isSuperAdmin) {
      const { rows } = await query(`
        SELECT o.*, 
               COUNT(DISTINCT c.id) as total_campuses,
               COUNT(DISTINCT m.id) as total_members
        FROM organizations o
        LEFT JOIN campuses c ON c.organization_id = o.id
        LEFT JOIN members m ON m.organization_id = o.id
        GROUP BY o.id
        ORDER BY o.created_at ASC
      `);
      return apiResponse(200, { data: rows });
    }

    const { rows } = await query(`
      SELECT o.*, 
             COUNT(DISTINCT c.id) as total_campuses,
             COUNT(DISTINCT m.id) as total_members
      FROM organizations o
      LEFT JOIN campuses c ON c.organization_id = o.id
      LEFT JOIN members m ON m.organization_id = o.id
      WHERE o.id = ?
      GROUP BY o.id
    `, [auth.user.organizationId]);

    return apiResponse(200, { data: rows });
  } catch (error: any) {
    console.error('Erro ao listar organizações:', error);
    return apiResponse(500, { error: 'Erro ao listar organizações' });
  }
};

// GET /organizations/{id}
export const getOrganization = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const id = event.pathParameters?.id || 'org_default';

    if (user) {
      const tenantCheck = enforceTenant(user, id);
      if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    }

    const { rows } = await query(`SELECT * FROM organizations WHERE id = ? OR slug = ? LIMIT 1`, [id, id]);
    if (rows.length === 0) {
      return apiResponse(404, { error: 'Organização não encontrada' });
    }
    return apiResponse(200, rows[0]);
  } catch (error: any) {
    console.error('Erro ao obter organização:', error);
    return apiResponse(500, { error: 'Erro ao obter organização' });
  }
};

// POST /organizations (PROTEGIDO: Somente SuperAdmin)
export const createOrUpdateOrganization = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN']);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const { id, name, slug, cnpj, plan, primary_color, secondary_color, logo_url, status } = body;

    // Se passou apenas ID e status para inativar/reativar
    if (id && status && !name && !slug) {
      await query(`UPDATE organizations SET status = ?, updated_at = NOW() WHERE id = ?`, [status, id]);
      await query(`UPDATE church_settings SET status = ?, updated_at = NOW() WHERE organization_id = ?`, [status, id]);

      await logSecurityEvent({
        organizationId: id,
        user: auth.user,
        action: 'UPDATE_ORGANIZATION_STATUS',
        resource: 'organizations',
        resourceId: id,
        details: { new_status: status },
        event
      });

      return apiResponse(200, { message: `Status da organização atualizado para ${status}`, organization_id: id, status });
    }

    if (!name || !slug) {
      return apiResponse(400, { error: 'Nome e slug são campos obrigatórios' });
    }

    const orgId = id || uuidv4();
    const cleanSlug = slug.toLowerCase().trim().replace(/[^a-z0-9-]/g, '-');
    const sql = `
      INSERT INTO organizations (id, name, slug, cnpj, plan, primary_color, secondary_color, logo_url, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        slug = VALUES(slug),
        cnpj = VALUES(cnpj),
        plan = VALUES(plan),
        primary_color = VALUES(primary_color),
        secondary_color = VALUES(secondary_color),
        logo_url = VALUES(logo_url),
        status = VALUES(status),
        updated_at = NOW()
    `;

    await query(sql, [
      orgId,
      name,
      cleanSlug,
      cnpj || '',
      plan || 'PRO',
      primary_color || '#0f766e',
      secondary_color || '#14b8a6',
      logo_url || '',
      status || 'ACTIVE'
    ]);

    if (id) {
      await query(
        `UPDATE church_settings SET church_name = ?, pwa_slug = ?, primary_color = ?, secondary_color = ?, status = ?, updated_at = NOW() WHERE organization_id = ?`,
        [name, cleanSlug, primary_color || '#0f766e', secondary_color || '#14b8a6', status || 'ACTIVE', id]
      );
    }

    await logSecurityEvent({
      organizationId: orgId,
      user: auth.user,
      action: id ? 'UPDATE_ORGANIZATION' : 'CREATE_ORGANIZATION',
      resource: 'organizations',
      resourceId: orgId,
      details: { name, slug: cleanSlug, plan: plan || 'PRO' },
      event
    });

    return apiResponse(200, { message: 'Organização salva com sucesso!', organization_id: orgId });
  } catch (error: any) {
    console.error('Erro ao salvar organização:', error);
    return apiResponse(500, { error: 'Erro ao salvar organização' });
  }
};
