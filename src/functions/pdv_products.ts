import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';

const STORE_ADMIN_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER', 'VOLUNTEER'];

// GET /pdv/products
export const getProducts = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const admin = event.queryStringParameters?.admin === 'true';
    const requestedOrgId = event.queryStringParameters?.organization_id;
    const campusId = event.queryStringParameters?.campus_id;

    const orgId = user ? enforceTenant(user, requestedOrgId).effectiveOrgId : (requestedOrgId || 'org_default');

    let sql = `SELECT * FROM pdv_products WHERE organization_id = ?`;
    const params: any[] = [orgId];

    if (campusId && campusId !== 'all') {
      sql += ` AND (campus_id = ? OR campus_id IS NULL)`;
      params.push(campusId);
    }
    if (!admin) {
      sql += ` AND status = 'ACTIVE'`;
    }

    sql += ` ORDER BY category, name`;

    const { rows } = await query(sql, params);

    const formatted = rows.map((r: any) => ({
      ...r,
      price: Number(r.price) || 0,
      image_urls: typeof r.image_urls === 'string' ? JSON.parse(r.image_urls || '[]') : (r.image_urls || [])
    }));

    return apiResponse(200, formatted);
  } catch (error: any) {
    return apiResponse(500, { message: 'Erro ao buscar produtos PDV' });
  }
};

// POST /pdv/products
export const createOrUpdateProduct = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, STORE_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const isUpdate = !!body.id;
    const id = body.id || uuidv4();

    const tenantCheck = enforceTenant(auth.user, body.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgValue = tenantCheck.effectiveOrgId;

    const campusValue = body.campus_id || 'campus_sede';

    const qValues = [
      body.name,
      body.description || null,
      body.price || 0.00,
      body.category || 'Geral',
      body.image_urls ? JSON.stringify(body.image_urls) : '[]',
      body.status || 'DRAFT'
    ];

    if (isUpdate) {
      const uQ = `UPDATE pdv_products SET name=?, description=?, price=?, category=?, image_urls=?, status=?, campus_id=? WHERE id=?`;
      await query(uQ, [...qValues, campusValue, id]);
    } else {
      const iQ = `INSERT INTO pdv_products (name, description, price, category, image_urls, status, organization_id, campus_id, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      await query(iQ, [...qValues, orgValue, campusValue, id]);
    }

    await logSecurityEvent({
      organizationId: orgValue,
      user: auth.user,
      action: isUpdate ? 'UPDATE_PDV_PRODUCT' : 'CREATE_PDV_PRODUCT',
      resource: 'pdv_products',
      resourceId: id,
      details: { name: body.name, price: body.price },
      event
    });

    return apiResponse(isUpdate ? 200 : 201, { message: 'Produto salvo com sucesso!', id });
  } catch (err: any) {
    return apiResponse(500, { error: 'Erro ao salvar produto' });
  }
};

// DELETE /pdv/products/{id}
export const deleteProduct = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN']);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID é obrigatório' });

    const { rows } = await query(`SELECT organization_id, name FROM pdv_products WHERE id = ? LIMIT 1`, [id]);
    if (rows.length === 0) return apiResponse(404, { message: 'Produto não encontrado' });

    const tenantCheck = enforceTenant(auth.user, rows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    await query(`DELETE FROM pdv_products WHERE id = ?`, [id]);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'DELETE_PDV_PRODUCT',
      resource: 'pdv_products',
      resourceId: id,
      details: { name: rows[0].name },
      event
    });

    return apiResponse(200, { message: 'Produto excluído com sucesso' });
  } catch (err: any) {
    return apiResponse(500, { error: 'Erro ao excluir produto' });
  }
};
