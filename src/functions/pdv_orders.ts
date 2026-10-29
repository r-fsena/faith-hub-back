import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse, getConnection } from '../db';
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';
import { checkRateLimit } from '../services/rateLimiter';
import { InventoryError, reserveOrderInventory, transitionOrderInventory } from '../services/pdvInventoryService';
import { evaluateTenantFlags } from '../services/featureFlagService';

const STORE_ADMIN_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'TREASURER', 'LEADER', 'VOLUNTEER'];

// POST /pdv/orders
export const createOrder = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let connection: Awaited<ReturnType<typeof getConnection>> | undefined;
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
    const campusValue = campus_id || 'campus_sede';
    const { rows: campusRows } = await query('SELECT id FROM campuses WHERE id = ? AND organization_id = ?', [campusValue, orgValue]);
    if (!campusRows.length && campusValue !== 'campus_sede') return apiResponse(400, { message: 'Unidade inválida.' });
    const featureFlags = await evaluateTenantFlags(orgValue, campusValue, 'production');
    const inventoryEnabled = Boolean(featureFlags.flags['pdv.stock_inventory']);
    const finalMethod = body.payment_method || 'PIX';
    if (finalMethod !== 'PIX') return apiResponse(409, { message: 'Pagamento por cartão indisponível. Utilize Pix.' });
    const requestedItems = typeof body.items_json === 'string' ? JSON.parse(body.items_json) : body.items_json;
    if (!Array.isArray(requestedItems) || !requestedItems.length || requestedItems.length > 100) return apiResponse(400, { message: 'Itens inválidos.' });
    const productIds = requestedItems.map((item: any) => String(item?.id || ''));
    if (new Set(productIds).size !== productIds.length) return apiResponse(400, { message: 'O mesmo produto não pode ser enviado em linhas duplicadas.' });
    const orderedItems = [...requestedItems].sort((left: any, right: any) => String(left.id).localeCompare(String(right.id)));
    const items: Array<{ id: string; name: string; qty: number; price: number; obs: string; track_inventory: boolean }> = [];
    let totalCents = 0;
    connection = await getConnection();
    await connection.beginTransaction();
    for (const item of orderedItems) {
      if (!item.id || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 100) {
        throw new InventoryError('INVALID_ORDER_ITEM', 'Produto ou quantidade inválidos.', 400);
      }
      const [productRows] = await connection.query(
        `SELECT id, name, price, track_inventory FROM pdv_products
          WHERE id = ? AND organization_id = ? AND status = 'ACTIVE' AND is_available_for_purchase = 1
            AND (campus_id = ? OR campus_id IS NULL)
          FOR UPDATE`,
        [item.id, orgValue, campusValue]
      );
      const product = (productRows as any[])[0];
      if (!product) throw new InventoryError('PRODUCT_UNAVAILABLE', 'Produto indisponível nesta igreja.', 400);
      const priceCents = Math.round(Number(product.price) * 100);
      if (!Number.isSafeInteger(priceCents) || priceCents < 0) throw new InventoryError('INVALID_PRICE', 'Preço inválido.', 400);
      totalCents += priceCents * item.qty;
      items.push({ id: product.id, name: product.name, qty: item.qty, price: priceCents / 100, obs: String(item.obs || '').slice(0, 500), track_inventory: inventoryEnabled && Boolean(product.track_inventory) });
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

    await connection.query(sql, [
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

    for (const item of items) {
      await connection.query(
        `INSERT INTO pdv_order_items
          (id, organization_id, campus_id, order_id, product_id, product_name, quantity,
           unit_price, line_total, observation, track_inventory)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), orgValue, campusValue, orderId, item.id, item.name, item.qty, item.price, item.price * item.qty, item.obs || null, item.track_inventory ? 1 : 0]
      );
    }

    const reservationMinutes = Math.max(5, Number(process.env.PDV_STOCK_RESERVATION_MINUTES || 30));
    const expiresAt = new Date(Date.now() + reservationMinutes * 60_000);
    await reserveOrderInventory(connection, {
      organizationId: orgValue,
      campusId: campusValue,
      orderId,
      items: items.map(item => ({ productId: item.id, quantity: item.qty, trackInventory: item.track_inventory })),
      actorId: user?.userId || null,
      expiresAt
    });
    await connection.commit();

    await logSecurityEvent({ organizationId: orgValue, campusId: campusValue, user, action: 'CREATE_PDV_ORDER', resource: 'pdv_orders', resourceId: orderId, details: { total_price: totalCents / 100, payment_status: finalPayStatus, stock_reserved: items.some(item => item.track_inventory), reservation_expires_at: expiresAt.toISOString() }, event });
    return apiResponse(201, {
      message: 'Pedido criado com sucesso',
      id: orderId,
      status: 'RECEBIDO',
      payment_status: finalPayStatus,
      total_price: totalCents / 100,
      reservation_expires_at: expiresAt.toISOString()
    });
  } catch (error: any) {
    if (connection) await connection.rollback();
    if (error instanceof InventoryError) return apiResponse(error.statusCode, { error: error.code, message: error.message });
    console.error('Erro criando pedido:', error);
    return apiResponse(500, { message: 'Erro ao criar pedido' });
  } finally {
    connection?.release();
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
  let connection: Awaited<ReturnType<typeof getConnection>> | undefined;
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, STORE_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID ausente' });

    const scope = enforceTenant(auth.user, event.queryStringParameters?.organization_id || event.headers?.['x-organization-id']);
    if (!scope.allowed) return scope.errorResponse!;
    connection = await getConnection();
    await connection.beginTransaction();
    const [existingRows] = await connection.query(
      `SELECT organization_id, campus_id, total_price, status, payment_status
         FROM pdv_orders WHERE id = ? AND organization_id = ? LIMIT 1 FOR UPDATE`,
      [id, scope.effectiveOrgId]
    );
    const existing = existingRows as any[];
    if (existing.length === 0) {
      await connection.rollback();
      return apiResponse(404, { message: 'Pedido não encontrado' });
    }

    const tenantCheck = enforceTenant(auth.user, existing[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const { status, payment_status } = body;

    if (status && !['RECEBIDO', 'PREPARANDO', 'PRONTO', 'ENTREGUE', 'CANCELADO'].includes(status)) {
      await connection.rollback();
      return apiResponse(400, { message: 'Status operacional inválido.' });
    }
    if (existing[0].status === 'CANCELADO' && status && status !== 'CANCELADO') {
      await connection.rollback();
      return apiResponse(409, { message: 'Um pedido cancelado não pode ser reaberto. Crie um novo pedido.' });
    }
    if (status === 'CANCELADO') {
      const cancellationRole = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN', 'TREASURER']);
      if (!cancellationRole.allowed) {
        await connection.rollback();
        return cancellationRole.errorResponse!;
      }
    }

    let updateFields: string[] = [];
    let params: any[] = [];

    if (status) {
      updateFields.push('status = ?');
      params.push(status);
    }

    if (payment_status) {
      const paymentRole = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN', 'TREASURER']);
      if (!paymentRole.allowed) {
        await connection.rollback();
        return paymentRole.errorResponse!;
      }
      if (!['PENDING', 'PAID', 'CANCELED'].includes(payment_status)) {
        await connection.rollback();
        return apiResponse(400, { message: 'Status de pagamento inválido.' });
      }
      if (existing[0].status === 'CANCELADO' && payment_status === 'PAID') {
        await connection.rollback();
        return apiResponse(409, { message: 'Não é possível confirmar pagamento de um pedido cancelado.' });
      }
      updateFields.push('payment_status = ?');
      params.push(payment_status);
    }

    if (status === 'CANCELADO' && !payment_status) {
      updateFields.push('payment_status = ?');
      params.push('CANCELED');
    }

    if (updateFields.length === 0) {
      await connection.rollback();
      return apiResponse(400, { message: 'Nenhum campo para atualizar (status ou payment_status)' });
    }

    let stockTransition: any = { action: 'NONE', affected: 0 };
    const isConfirmingPayment = payment_status === 'PAID' && existing[0].payment_status !== 'PAID';
    const isCanceling = (status === 'CANCELADO' && existing[0].status !== 'CANCELADO')
      || (payment_status === 'CANCELED' && existing[0].payment_status !== 'CANCELED');
    if (isConfirmingPayment) {
      stockTransition = await transitionOrderInventory(connection, {
        organizationId: tenantCheck.effectiveOrgId,
        orderId: id,
        transition: 'COMMIT',
        actorId: auth.user.userId
      });
    } else if (isCanceling) {
      stockTransition = await transitionOrderInventory(connection, {
        organizationId: tenantCheck.effectiveOrgId,
        orderId: id,
        transition: 'CANCEL',
        actorId: auth.user.userId
      });
    }

    params.push(id, tenantCheck.effectiveOrgId);
    const sql = `UPDATE pdv_orders SET ${updateFields.join(', ')}, updated_at = NOW() WHERE id = ? AND organization_id = ?`;

    await connection.query(sql, params);
    await connection.commit();

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'UPDATE_PDV_ORDER_STATUS',
      resource: 'pdv_orders',
      resourceId: id,
      campusId: existing[0].campus_id,
      details: { status, payment_status, stock_transition: stockTransition },
      event
    });

    return apiResponse(200, { message: 'Status do pedido atualizado com sucesso', id, stock_transition: stockTransition });
  } catch (error: any) {
    if (connection) await connection.rollback();
    if (error instanceof InventoryError) return apiResponse(error.statusCode, { error: error.code, message: error.message });
    console.error('Erro atualizando pedido:', error);
    return apiResponse(500, { message: 'Erro ao atualizar pedido' });
  } finally {
    connection?.release();
  }
};
