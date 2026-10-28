import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { apiResponse, getConnection, query } from '../db';
import { AuthUser, enforcePermission, enforceRole, enforceTenant, requireAuth } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';
import { applyManualInventoryMovement, InventoryError, transitionOrderInventory } from '../services/pdvInventoryService';
import { evaluateTenantFlags } from '../services/featureFlagService';

const VIEW_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'TREASURER', 'LEADER', 'VOLUNTEER'];
const MANAGE_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'TREASURER', 'LEADER', 'VOLUNTEER'];
const MOVEMENT_TYPES = new Set(['ENTRY', 'EXIT', 'ADJUSTMENT', 'LOSS', 'OPENING_BALANCE']);

async function inventoryAuth(
  event: APIGatewayProxyEvent,
  permission: 'inventory.view' | 'inventory.manage'
): Promise<{ user: AuthUser; organizationId: string } | { errorResponse: APIGatewayProxyResult }> {
  const auth = await requireAuth(event);
  if ('errorResponse' in auth) return auth;
  const role = enforceRole(auth.user, permission === 'inventory.view' ? VIEW_ROLES : MANAGE_ROLES);
  if (!role.allowed) return { errorResponse: role.errorResponse! };
  const access = enforcePermission(
    auth.user,
    permission,
    permission === 'inventory.view' ? ['SUPERADMIN', 'PASTOR', 'ADMIN', 'TREASURER'] : ['SUPERADMIN', 'PASTOR', 'ADMIN']
  );
  if (!access.allowed) return { errorResponse: access.errorResponse! };
  let parsedBody: any = {};
  try { parsedBody = JSON.parse(event.body || '{}'); } catch {}
  const requestedOrgId = event.queryStringParameters?.organization_id || parsedBody.organization_id;
  const tenant = enforceTenant(auth.user, requestedOrgId);
  if (!tenant.allowed) return { errorResponse: tenant.errorResponse! };
  const requestedCampus = event.queryStringParameters?.campus_id || parsedBody.campus_id;
  const flags = await evaluateTenantFlags(tenant.effectiveOrgId, requestedCampus && requestedCampus !== 'all' ? requestedCampus : null, 'production');
  if (!flags.flags['pdv.stock_inventory']) {
    return { errorResponse: apiResponse(403, { error: 'FEATURE_DISABLED', message: 'O controle de estoque não está habilitado para esta organização.' }) };
  }
  return { user: auth.user, organizationId: tenant.effectiveOrgId };
}

// GET /pdv/inventory
export const getInventory = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const scope = await inventoryAuth(event, 'inventory.view');
    if ('errorResponse' in scope) return scope.errorResponse;
    const campusId = event.queryStringParameters?.campus_id;
    const search = String(event.queryStringParameters?.search || '').trim();
    const params: any[] = [scope.organizationId];
    let campusJoin = '';
    let productScope = '';
    if (campusId && campusId !== 'all') {
      campusJoin = ' AND b.campus_id = ?';
      params.push(campusId);
      productScope = ' AND (p.campus_id = ? OR p.campus_id IS NULL)';
    }
    let searchScope = '';
    const trailingParams: any[] = [];
    if (campusId && campusId !== 'all') trailingParams.push(campusId);
    if (search) {
      searchScope = ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)';
      const value = `%${search}%`;
      trailingParams.push(value, value, value);
    }
    const { rows } = await query(
      `SELECT p.id AS product_id, p.name, p.category, p.sku, p.barcode, p.unit, p.status,
              p.track_inventory, COALESCE(b.campus_id, p.campus_id, 'campus_sede') AS campus_id,
              COALESCE(c.name, 'Unidade principal') AS campus_name,
              COALESCE(b.on_hand_quantity, 0) AS on_hand_quantity,
              COALESCE(b.reserved_quantity, 0) AS reserved_quantity,
              COALESCE(b.on_hand_quantity, 0) - COALESCE(b.reserved_quantity, 0) AS available_quantity,
              COALESCE(b.minimum_stock, 0) AS minimum_stock,
              CASE
                WHEN p.track_inventory = 0 THEN 'NOT_TRACKED'
                WHEN COALESCE(b.on_hand_quantity, 0) - COALESCE(b.reserved_quantity, 0) <= 0 THEN 'OUT_OF_STOCK'
                WHEN COALESCE(b.on_hand_quantity, 0) - COALESCE(b.reserved_quantity, 0) <= COALESCE(b.minimum_stock, 0) THEN 'LOW_STOCK'
                ELSE 'HEALTHY'
              END AS stock_status
         FROM pdv_products p
         LEFT JOIN pdv_inventory_balances b
           ON b.organization_id = p.organization_id AND b.product_id = p.id${campusJoin}
         LEFT JOIN campuses c
           ON c.organization_id = p.organization_id AND c.id = COALESCE(b.campus_id, p.campus_id, 'campus_sede')
        WHERE p.organization_id = ?${productScope}${searchScope}
        ORDER BY FIELD(stock_status, 'OUT_OF_STOCK', 'LOW_STOCK', 'HEALTHY', 'NOT_TRACKED'), p.name, campus_name`,
      [...params.slice(1), params[0], ...trailingParams]
    );
    const inventory = rows.map((row: any) => ({
      ...row,
      track_inventory: Boolean(row.track_inventory),
      on_hand_quantity: Number(row.on_hand_quantity) || 0,
      reserved_quantity: Number(row.reserved_quantity) || 0,
      available_quantity: Number(row.available_quantity) || 0,
      minimum_stock: Number(row.minimum_stock) || 0
    }));
    const tracked = inventory.filter((item: any) => item.track_inventory);
    return apiResponse(200, {
      summary: {
        products: tracked.length,
        units_on_hand: tracked.reduce((total: number, item: any) => total + item.on_hand_quantity, 0),
        units_reserved: tracked.reduce((total: number, item: any) => total + item.reserved_quantity, 0),
        low_stock: tracked.filter((item: any) => item.stock_status === 'LOW_STOCK').length,
        out_of_stock: tracked.filter((item: any) => item.stock_status === 'OUT_OF_STOCK').length
      },
      inventory
    });
  } catch (error: any) {
    console.error('Erro listando estoque:', error);
    return apiResponse(500, { message: 'Erro ao carregar o estoque.' });
  }
};

// GET /pdv/inventory/movements
export const getMovements = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const scope = await inventoryAuth(event, 'inventory.view');
    if ('errorResponse' in scope) return scope.errorResponse;
    const campusId = event.queryStringParameters?.campus_id;
    const productId = event.queryStringParameters?.product_id;
    let sql = `SELECT m.*, p.name AS product_name, p.sku, p.unit
      FROM pdv_inventory_movements m
      INNER JOIN pdv_products p ON p.id = m.product_id AND p.organization_id = m.organization_id
      WHERE m.organization_id = ?`;
    const params: any[] = [scope.organizationId];
    if (campusId && campusId !== 'all') {
      sql += ' AND m.campus_id = ?';
      params.push(campusId);
    }
    if (productId) {
      sql += ' AND m.product_id = ?';
      params.push(productId);
    }
    sql += ' ORDER BY m.created_at DESC LIMIT 200';
    const { rows } = await query(sql, params);
    return apiResponse(200, rows.map((row: any) => ({
      ...row,
      quantity_delta: Number(row.quantity_delta) || 0,
      reserved_delta: Number(row.reserved_delta) || 0,
      previous_on_hand: Number(row.previous_on_hand) || 0,
      new_on_hand: Number(row.new_on_hand) || 0
    })));
  } catch (error: any) {
    console.error('Erro listando movimentações:', error);
    return apiResponse(500, { message: 'Erro ao carregar as movimentações.' });
  }
};

// POST /pdv/inventory/movements
export const createMovement = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let connection: Awaited<ReturnType<typeof getConnection>> | undefined;
  try {
    const scope = await inventoryAuth(event, 'inventory.manage');
    if ('errorResponse' in scope) return scope.errorResponse;
    const body = JSON.parse(event.body || '{}');
    const type = String(body.type || '').toUpperCase();
    const quantity = Number(body.quantity);
    const campusId = String(body.campus_id || '');
    const productId = String(body.product_id || '');
    const reason = String(body.reason || '').trim();
    if (!MOVEMENT_TYPES.has(type)) return apiResponse(400, { message: 'Tipo de movimentação inválido.' });
    if (!campusId || !productId || !reason) return apiResponse(400, { message: 'Produto, unidade e motivo são obrigatórios.' });
    if (!Number.isFinite(quantity) || quantity < 0 || (quantity === 0 && !['ADJUSTMENT', 'OPENING_BALANCE'].includes(type))) {
      return apiResponse(400, { message: 'Informe uma quantidade válida.' });
    }
    const { rows: products } = await query(
      'SELECT id, track_inventory FROM pdv_products WHERE id = ? AND organization_id = ? LIMIT 1',
      [productId, scope.organizationId]
    );
    if (!products.length) return apiResponse(404, { message: 'Produto não encontrado.' });
    if (!products[0].track_inventory) return apiResponse(409, { message: 'Ative o controle de estoque deste produto antes de movimentá-lo.' });
    const { rows: campuses } = await query('SELECT id FROM campuses WHERE id = ? AND organization_id = ? LIMIT 1', [campusId, scope.organizationId]);
    if (!campuses.length && campusId !== 'campus_sede') return apiResponse(400, { message: 'Unidade inválida.' });

    connection = await getConnection();
    await connection.beginTransaction();
    const result = await applyManualInventoryMovement(connection, {
      organizationId: scope.organizationId,
      campusId,
      productId,
      type: type as any,
      quantity,
      reason,
      notes: body.notes ? String(body.notes).slice(0, 2000) : null,
      actorId: scope.user.userId
    });
    await connection.commit();
    await logSecurityEvent({
      organizationId: scope.organizationId,
      campusId,
      user: scope.user,
      action: 'CREATE_PDV_INVENTORY_MOVEMENT',
      resource: 'pdv_inventory_movements',
      resourceId: productId,
      details: { type, quantity, reason, ...result },
      event
    });
    return apiResponse(201, { message: 'Movimentação registrada com sucesso.', ...result });
  } catch (error: any) {
    if (connection) await connection.rollback();
    if (error instanceof InventoryError) return apiResponse(error.statusCode, { error: error.code, message: error.message });
    console.error('Erro criando movimentação:', error);
    return apiResponse(500, { message: 'Erro ao registrar a movimentação.' });
  } finally {
    connection?.release();
  }
};

// PUT /pdv/inventory/{productId}/settings
export const updateInventorySettings = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const scope = await inventoryAuth(event, 'inventory.manage');
    if ('errorResponse' in scope) return scope.errorResponse;
    const body = JSON.parse(event.body || '{}');
    const productId = event.pathParameters?.productId;
    const campusId = String(body.campus_id || '');
    const minimumStock = Number(body.minimum_stock);
    if (!productId || !campusId || !Number.isFinite(minimumStock) || minimumStock < 0) {
      return apiResponse(400, { message: 'Produto, unidade e estoque mínimo válido são obrigatórios.' });
    }
    const { rows: products } = await query('SELECT id FROM pdv_products WHERE id = ? AND organization_id = ? LIMIT 1', [productId, scope.organizationId]);
    if (!products.length) return apiResponse(404, { message: 'Produto não encontrado.' });
    await query(
      `INSERT INTO pdv_inventory_balances
        (id, organization_id, campus_id, product_id, minimum_stock)
       VALUES (UUID(), ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE minimum_stock = VALUES(minimum_stock), updated_at = NOW()`,
      [scope.organizationId, campusId, productId, minimumStock]
    );
    await logSecurityEvent({
      organizationId: scope.organizationId,
      campusId,
      user: scope.user,
      action: 'UPDATE_PDV_INVENTORY_SETTINGS',
      resource: 'pdv_inventory_balances',
      resourceId: productId,
      details: { minimum_stock: minimumStock },
      event
    });
    return apiResponse(200, { message: 'Estoque mínimo atualizado.' });
  } catch (error: any) {
    console.error('Erro atualizando configuração de estoque:', error);
    return apiResponse(500, { message: 'Erro ao atualizar a configuração.' });
  }
};

// EventBridge: libera reservas Pix que não foram confirmadas no prazo.
export const expireReservations = async (): Promise<void> => {
  const { rows } = await query(
    `SELECT DISTINCT organization_id, order_id
       FROM pdv_inventory_reservations
      WHERE status = 'ACTIVE' AND expires_at <= NOW()
      ORDER BY expires_at
      LIMIT 100`
  );
  for (const row of rows) {
    const connection = await getConnection();
    try {
      await connection.beginTransaction();
      const [orders] = await connection.query(
        `SELECT id, status, payment_status FROM pdv_orders
          WHERE id = ? AND organization_id = ? FOR UPDATE`,
        [row.order_id, row.organization_id]
      );
      const order = (orders as any[])[0];
      if (!order || order.payment_status === 'PAID') {
        await connection.rollback();
        continue;
      }
      const transition = await transitionOrderInventory(connection, {
        organizationId: row.organization_id,
        orderId: row.order_id,
        transition: 'CANCEL',
        reason: 'Reserva expirada sem confirmação de pagamento'
      });
      await connection.query(
        `UPDATE pdv_orders SET status = 'CANCELADO', payment_status = 'CANCELED', updated_at = NOW()
          WHERE id = ? AND organization_id = ? AND payment_status <> 'PAID'`,
        [row.order_id, row.organization_id]
      );
      await connection.commit();
      await logSecurityEvent({
        organizationId: row.organization_id,
        action: 'EXPIRE_PDV_INVENTORY_RESERVATION',
        resource: 'pdv_orders',
        resourceId: row.order_id,
        details: transition
      });
    } catch (error) {
      await connection.rollback();
      console.error('Erro expirando reserva do pedido:', row.order_id, error);
    } finally {
      connection.release();
    }
  }
};

// Uma única Lambda atende as rotas privadas e a expiração agendada, reduzindo
// recursos de CloudFormation sem alterar o contrato público dos endpoints.
export const inventoryHandler = async (event: APIGatewayProxyEvent | any): Promise<APIGatewayProxyResult | void> => {
  if (event?.source === 'aws.events' || !event?.requestContext?.http) {
    await expireReservations();
    return;
  }
  const method = String(event.requestContext.http.method || event.httpMethod || '').toUpperCase();
  const path = String(event.rawPath || event.path || '');
  if (method === 'GET' && path.endsWith('/pdv/inventory')) return getInventory(event);
  if (method === 'GET' && path.endsWith('/pdv/inventory/movements')) return getMovements(event);
  if (method === 'POST' && path.endsWith('/pdv/inventory/movements')) return createMovement(event);
  if (method === 'PUT' && /\/pdv\/inventory\/[^/]+\/settings$/.test(path)) return updateInventorySettings(event);
  return apiResponse(404, { message: 'Rota de estoque não encontrada.' });
};
