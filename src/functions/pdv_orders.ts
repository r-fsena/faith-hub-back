import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';
import { checkRateLimit } from '../services/rateLimiter';

const STORE_ADMIN_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER', 'VOLUNTEER'];

// POST /pdv/orders
export const createOrder = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const rateCheck = await checkRateLimit(event, {
      maxRequests: 20,
      windowSeconds: 60,
      identifierPrefix: 'pdv_create_order'
    });
    if (!rateCheck.allowed) return rateCheck.errorResponse!;

    const user = await getAuthenticatedUser(event);
    const body = JSON.parse(event.body || '{}');
    const { user_name, customer_phone, delivery_method, delivery_details, organization_id, campus_id } = body;
    if (!user_name || !organization_id) return apiResponse(400, { message: 'Nome e organização são obrigatórios.' });
    const tenantCheck = user ? enforceTenant(user, organization_id) : null;
    if (tenantCheck && !tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgValue = tenantCheck?.effectiveOrgId || organization_id;
    const campusValue = campus_id || null;
    if (campusValue) {
      const { rows } = await query('SELECT id FROM campuses WHERE id = ? AND organization_id = ?', [campusValue, orgValue]);
      if (!rows.length) return apiResponse(400, { message: 'Unidade inválida.' });
    }
    const finalMethod = body.payment_method || 'PIX';
    if (finalMethod !== 'PIX') return apiResponse(409, { message: 'Pagamento por cartão indisponível. Utilize Pix.' });
    const requestedItems = typeof body.items_json === 'string' ? JSON.parse(body.items_json) : body.items_json;
    if (!Array.isArray(requestedItems) || !requestedItems.length || requestedItems.length > 100) return apiResponse(400, { message: 'Itens inválidos.' });
    const items: Array<{ id: string; name: string; qty: number; price: number; obs: string }> = [];
    let totalCents = 0;
    for (const item of requestedItems) {
      if (!item.id || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 100) return apiResponse(400, { message: 'Produto ou quantidade inválidos.' });
      const { rows } = await query(`SELECT id, name, price FROM pdv_products WHERE id = ? AND organization_id = ? AND status = 'ACTIVE'`, [item.id, orgValue]);
      if (!rows.length) return apiResponse(400, { message: 'Produto indisponível nesta igreja.' });
      const product = rows[0];
      const priceCents = Math.round(Number(product.price) * 100);
      if (!Number.isSafeInteger(priceCents) || priceCents < 0) return apiResponse(400, { message: 'Preço inválido.' });
      totalCents += priceCents * item.qty;
      items.push({ id: product.id, name: product.name, qty: item.qty, price: priceCents / 100, obs: String(item.obs || '').slice(0, 500) });
    }
    const orderId = uuidv4();
    const userId = user?.userId || 'GUEST';
    const itemsString = JSON.stringify(items);
    const finalPhone = customer_phone || '';
    const finalPayStatus = 'PENDING';
    const sql = `
      INSERT INTO pdv_orders 
        (id, user_id, user_name, customer_phone, status, payment_method, payment_status, delivery_method, delivery_details, items_json, total_price, organization_id, campus_id) 
      VALUES (?, ?, ?, ?, 'RECEBIDO', ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await query(sql, [
      orderId,
      userId,
      user_name,
      finalPhone,
      finalMethod,
      finalPayStatus,
      delivery_method || 'church',
      delivery_details || '',
      itemsString,
      totalCents / 100,
      orgValue,
      campusValue
    ]);

    await logSecurityEvent({ organizationId: orgValue, user, action: 'CREATE_PDV_ORDER', resource: 'pdv_orders', resourceId: orderId, details: { total_price: totalCents / 100, payment_status: finalPayStatus }, event });
    return apiResponse(201, {
      message: 'Pedido criado com sucesso',
      id: orderId,
      status: 'RECEBIDO',
      payment_status: finalPayStatus,
      total_price: totalCents / 100
    });
  } catch (error: any) {
    console.error('Erro criando pedido:', error);
    return apiResponse(500, { message: 'Erro ao criar pedido' });
  }
};

// GET /pdv/orders
export const getOrders = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;
    const user = auth.user;
    const status = event.queryStringParameters?.status;
    const paymentStatus = event.queryStringParameters?.payment_status;
    const isStaff = user.isSuperAdmin || STORE_ADMIN_ROLES.includes(user.role);
    const userId = isStaff ? event.queryStringParameters?.user_id : user.userId;
    const requestedOrgId = event.queryStringParameters?.organization_id;
    const campusId = event.queryStringParameters?.campus_id;

    const tenantCheck = enforceTenant(user, requestedOrgId);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgId = tenantCheck.effectiveOrgId;

    let sql = 'SELECT * FROM pdv_orders WHERE organization_id = ?';
    const params: any[] = [orgId];

    if (campusId && campusId !== 'all') {
      sql += ' AND (campus_id = ? OR campus_id IS NULL)';
      params.push(campusId);
    }

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    if (paymentStatus) {
      sql += ' AND payment_status = ?';
      params.push(paymentStatus);
    }

    if (userId) {
      sql += ' AND user_id = ?';
      params.push(userId);
    }

    sql += ' ORDER BY created_at DESC LIMIT 100';

    const { rows } = await query(sql, params);

    const formatted = rows.map((r: any) => ({
      ...r,
      items_json: typeof r.items_json === 'string' ? JSON.parse(r.items_json || '[]') : r.items_json,
      total_price: Number(r.total_price) || 0
    }));

    return apiResponse(200, formatted);
  } catch (error: any) {
    console.error('Erro listando pedidos:', error);
    return apiResponse(500, { message: 'Erro ao listar pedidos' });
  }
};

// PUT /pdv/orders/{id}/status
export const updateOrderStatus = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, STORE_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID ausente' });

    const scope = enforceTenant(auth.user, event.queryStringParameters?.organization_id || event.headers?.['x-organization-id']);
    if (!scope.allowed) return scope.errorResponse!;
    const { rows: existing } = await query(`SELECT organization_id, total_price FROM pdv_orders WHERE id = ? AND organization_id = ? LIMIT 1`, [id, scope.effectiveOrgId]);
    if (existing.length === 0) return apiResponse(404, { message: 'Pedido não encontrado' });

    const tenantCheck = enforceTenant(auth.user, existing[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const { status, payment_status } = body;

    let updateFields: string[] = [];
    let params: any[] = [];

    if (status) {
      updateFields.push('status = ?');
      params.push(status);
    }

    if (payment_status) {
      const paymentRole = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN', 'TREASURER']);
      if (!paymentRole.allowed) return paymentRole.errorResponse!;
      if (!['PENDING', 'PAID', 'CANCELED'].includes(payment_status)) return apiResponse(400, { message: 'Status de pagamento inválido.' });
      updateFields.push('payment_status = ?');
      params.push(payment_status);
    }

    if (updateFields.length === 0) {
      return apiResponse(400, { message: 'Nenhum campo para atualizar (status ou payment_status)' });
    }

    params.push(id, tenantCheck.effectiveOrgId);
    const sql = `UPDATE pdv_orders SET ${updateFields.join(', ')}, updated_at = NOW() WHERE id = ? AND organization_id = ?`;

    await query(sql, params);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'UPDATE_PDV_ORDER_STATUS',
      resource: 'pdv_orders',
      resourceId: id,
      details: { status, payment_status },
      event
    });

    return apiResponse(200, { message: 'Status do pedido atualizado com sucesso', id });
  } catch (error: any) {
    console.error('Erro atualizando pedido:', error);
    return apiResponse(500, { message: 'Erro ao atualizar pedido' });
  }
};
