import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';

const STORE_ADMIN_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER', 'VOLUNTEER'];

// POST /pdv/orders
export const createOrder = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const body = JSON.parse(event.body || '{}');
    const {
      user_name,
      customer_phone,
      delivery_method,
      delivery_details,
      items_json,
      total_price,
      payment_method,
      payment_status,
      organization_id,
      campus_id
    } = body;

    if (!user_name || !items_json) {
      return apiResponse(400, { message: 'Dados incompletos: nome do cliente e itens são obrigatórios.' });
    }

    const orgValue = user ? enforceTenant(user, organization_id).effectiveOrgId : (organization_id || 'org_default');
    const campusValue = campus_id || 'campus_sede';
    const userId = user?.userId || 'GUEST';

    const orderId = uuidv4();
    const itemsString = typeof items_json === 'string' ? items_json : JSON.stringify(items_json);
    const finalPhone = customer_phone || '';
    const finalMethod = payment_method || (delivery_details?.includes('CREDIT_CARD') ? 'CREDIT_CARD' : 'PIX');
    const finalPayStatus = payment_status || (finalMethod === 'CREDIT_CARD' ? 'PAID' : 'PENDING');

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
      total_price || 0.00,
      orgValue,
      campusValue
    ]);

    return apiResponse(201, {
      message: 'Pedido criado com sucesso',
      id: orderId,
      status: 'RECEBIDO',
      payment_status: finalPayStatus
    });
  } catch (error: any) {
    console.error('Erro criando pedido:', error);
    return apiResponse(500, { message: 'Erro ao criar pedido' });
  }
};

// GET /pdv/orders
export const getOrders = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const status = event.queryStringParameters?.status;
    const paymentStatus = event.queryStringParameters?.payment_status;
    const userId = event.queryStringParameters?.user_id;
    const requestedOrgId = event.queryStringParameters?.organization_id;
    const campusId = event.queryStringParameters?.campus_id;

    const orgId = user ? enforceTenant(user, requestedOrgId).effectiveOrgId : (requestedOrgId || 'org_default');

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

    const { rows: existing } = await query(`SELECT organization_id, total_price FROM pdv_orders WHERE id = ? LIMIT 1`, [id]);
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
      updateFields.push('payment_status = ?');
      params.push(payment_status);
    }

    if (updateFields.length === 0) {
      return apiResponse(400, { message: 'Nenhum campo para atualizar (status ou payment_status)' });
    }

    params.push(id);
    const sql = `UPDATE pdv_orders SET ${updateFields.join(', ')}, updated_at = NOW() WHERE id = ?`;

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
