import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { apiResponse, query } from '../db';
import { enforcePermission, enforceRole, enforceTenant, requireAuth } from '../services/authMiddleware';
import { evaluateTenantFlags } from '../services/featureFlagService';

const ANALYTICS_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'TREASURER', 'LEADER', 'VOLUNTEER'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY_LABELS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function resolvePeriod(event: APIGatewayProxyEvent): { startDate: string; endDate: string } | { error: APIGatewayProxyResult } {
  const now = new Date();
  const defaultStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startDate = event.queryStringParameters?.start_date || isoDate(defaultStart);
  const endDate = event.queryStringParameters?.end_date || isoDate(now);
  if (!DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate)) {
    return { error: apiResponse(400, { message: 'Período inválido. Use datas no formato AAAA-MM-DD.' }) };
  }
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const rangeDays = Math.floor((end.getTime() - start.getTime()) / 86_400_000);
  if (!Number.isFinite(rangeDays) || rangeDays < 0 || rangeDays > 366) {
    return { error: apiResponse(400, { message: 'Selecione um período entre 1 e 367 dias.' }) };
  }
  return { startDate, endDate };
}

function numericRow(row: any) {
  return {
    ...row,
    orders: Number(row.orders) || 0,
    quantity_sold: Number(row.quantity_sold) || 0,
    units_sold: Number(row.units_sold) || 0,
    revenue: Number(row.revenue) || 0,
    on_hand_quantity: Number(row.on_hand_quantity) || 0,
    reserved_quantity: Number(row.reserved_quantity) || 0,
    available_quantity: Number(row.available_quantity) || 0,
    minimum_stock: Number(row.minimum_stock) || 0
  };
}

// GET /pdv/analytics
export const getPdvAnalytics = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;
    const role = enforceRole(auth.user, ANALYTICS_ROLES);
    if (!role.allowed) return role.errorResponse!;
    const permission = enforcePermission(auth.user, 'inventory.view', ['SUPERADMIN', 'PASTOR', 'ADMIN', 'TREASURER']);
    if (!permission.allowed) return permission.errorResponse!;

    const tenant = enforceTenant(auth.user, event.queryStringParameters?.organization_id);
    if (!tenant.allowed) return tenant.errorResponse!;
    const organizationId = tenant.effectiveOrgId;
    const campusId = event.queryStringParameters?.campus_id;
    const scopedCampus = campusId && campusId !== 'all' ? campusId : null;
    const period = resolvePeriod(event);
    if ('error' in period) return period.error;

    const flags = await evaluateTenantFlags(organizationId, scopedCampus, 'production');
    if (!flags.flags['pdv.module_enabled']) {
      return apiResponse(403, { error: 'FEATURE_DISABLED', message: 'A Loja & Operações não está habilitada para esta organização.' });
    }

    const saleDate = 'COALESCE(o.paid_at, o.created_at)';
    const campusOrderFilter = scopedCampus ? ' AND o.campus_id = ?' : '';
    const orderFilter = `o.organization_id = ?
      AND o.payment_status = 'PAID' AND o.status <> 'CANCELADO'
      AND ${saleDate} >= ? AND ${saleDate} < DATE_ADD(?, INTERVAL 1 DAY)${campusOrderFilter}`;
    const orderParams = [organizationId, period.startDate, period.endDate, ...(scopedCampus ? [scopedCampus] : [])];

    const balanceCampusFilter = scopedCampus ? ' AND campus_id = ?' : '';
    const balanceParams = [organizationId, ...(scopedCampus ? [scopedCampus] : [])];
    const productCampusFilter = scopedCampus ? ' AND (p.campus_id = ? OR p.campus_id IS NULL)' : '';

    // As agregações são intencionalmente sequenciais para não multiplicar conexões
    // com o RDS quando vários administradores abrirem o painel ao mesmo tempo.
    const summaryResult = await query(
      `SELECT COUNT(*) AS paid_orders, COALESCE(SUM(o.total_price), 0) AS gross_sales,
              COALESCE(AVG(o.total_price), 0) AS average_ticket
         FROM pdv_orders o WHERE ${orderFilter}`,
      orderParams
    );
    const unitsResult = await query(
      `SELECT COALESCE(SUM(i.quantity), 0) AS units_sold
         FROM pdv_order_items i
         INNER JOIN pdv_orders o ON o.id = i.order_id AND o.organization_id = i.organization_id
        WHERE i.organization_id = ? AND ${orderFilter}`,
      [organizationId, ...orderParams]
    );
    const dailyResult = await query(
      `SELECT DATE_FORMAT(${saleDate}, '%Y-%m-%d') AS sale_date,
              WEEKDAY(${saleDate}) AS weekday,
              COUNT(*) AS orders, COALESCE(SUM(o.total_price), 0) AS revenue
         FROM pdv_orders o WHERE ${orderFilter}
        GROUP BY sale_date, weekday
        ORDER BY sale_date`,
      orderParams
    );
    const groupsResult = await query(
      `SELECT COALESCE(NULLIF(TRIM(p.category), ''), 'Geral') AS category,
              COUNT(DISTINCT i.order_id) AS orders,
              COALESCE(SUM(i.quantity), 0) AS quantity_sold,
              COALESCE(SUM(i.line_total), 0) AS revenue
         FROM pdv_order_items i
         INNER JOIN pdv_orders o ON o.id = i.order_id AND o.organization_id = i.organization_id
         INNER JOIN pdv_products p ON p.id = i.product_id AND p.organization_id = i.organization_id
        WHERE i.organization_id = ? AND p.organization_id = ? AND ${orderFilter}
        GROUP BY COALESCE(NULLIF(TRIM(p.category), ''), 'Geral')
        ORDER BY quantity_sold DESC, revenue DESC LIMIT 8`,
      [organizationId, organizationId, ...orderParams]
    );
    const productsResult = await query(
      `SELECT i.product_id, p.name, p.category, p.unit,
              COUNT(DISTINCT i.order_id) AS orders,
              COALESCE(SUM(i.quantity), 0) AS quantity_sold,
              COALESCE(SUM(i.line_total), 0) AS revenue,
              COALESCE(b.on_hand_quantity, 0) AS on_hand_quantity,
              COALESCE(b.reserved_quantity, 0) AS reserved_quantity,
              COALESCE(b.on_hand_quantity, 0) - COALESCE(b.reserved_quantity, 0) AS available_quantity,
              COALESCE(b.minimum_stock, 0) AS minimum_stock,
              p.track_inventory
         FROM pdv_order_items i
         INNER JOIN pdv_orders o ON o.id = i.order_id AND o.organization_id = i.organization_id
         INNER JOIN pdv_products p ON p.id = i.product_id AND p.organization_id = i.organization_id
         LEFT JOIN (
           SELECT product_id, SUM(on_hand_quantity) AS on_hand_quantity,
                  SUM(reserved_quantity) AS reserved_quantity, SUM(minimum_stock) AS minimum_stock
             FROM pdv_inventory_balances
            WHERE organization_id = ?${balanceCampusFilter}
            GROUP BY product_id
         ) b ON b.product_id = i.product_id
        WHERE i.organization_id = ? AND p.organization_id = ? AND ${orderFilter}${productCampusFilter}
        GROUP BY i.product_id, p.name, p.category, p.unit, p.track_inventory,
                 b.on_hand_quantity, b.reserved_quantity, b.minimum_stock
        ORDER BY quantity_sold DESC, revenue DESC LIMIT 10`,
      [...balanceParams, organizationId, organizationId, ...orderParams, ...(scopedCampus ? [scopedCampus] : [])]
    );
    const attentionResult = flags.flags['pdv.stock_inventory'] ? await query(
      `SELECT p.id AS product_id, p.name, p.category, p.unit,
              COALESCE(b.campus_id, p.campus_id, ?) AS campus_id,
              COALESCE(c.name, 'Unidade principal') AS campus_name,
              COALESCE(b.on_hand_quantity, 0) AS on_hand_quantity,
              COALESCE(b.reserved_quantity, 0) AS reserved_quantity,
              COALESCE(b.on_hand_quantity, 0) - COALESCE(b.reserved_quantity, 0) AS available_quantity,
              COALESCE(b.minimum_stock, 0) AS minimum_stock,
              CASE WHEN COALESCE(b.on_hand_quantity, 0) - COALESCE(b.reserved_quantity, 0) <= 0
                   THEN 'OUT_OF_STOCK' ELSE 'LOW_STOCK' END AS stock_status
         FROM pdv_products p
         LEFT JOIN pdv_inventory_balances b
           ON b.product_id = p.id AND b.organization_id = p.organization_id${scopedCampus ? ' AND b.campus_id = ?' : ''}
         LEFT JOIN campuses c ON c.id = COALESCE(b.campus_id, p.campus_id) AND c.organization_id = p.organization_id
        WHERE p.organization_id = ? AND p.track_inventory = 1 AND p.status = 'ACTIVE'${productCampusFilter}
          AND COALESCE(b.on_hand_quantity, 0) - COALESCE(b.reserved_quantity, 0) <= COALESCE(b.minimum_stock, 0)
        ORDER BY FIELD(stock_status, 'OUT_OF_STOCK', 'LOW_STOCK'), available_quantity, p.name
        LIMIT 10`,
      [scopedCampus || 'campus_sede', ...(scopedCampus ? [scopedCampus] : []), organizationId, ...(scopedCampus ? [scopedCampus] : [])]
    ) : { rows: [] as any[] };

    const summary = summaryResult.rows[0] || {};
    const daily = dailyResult.rows.map(numericRow);
    const weekdays = WEEKDAY_LABELS.map((label, weekday) => {
      const matching = daily.filter((row: any) => Number(row.weekday) === weekday);
      return {
        weekday,
        label,
        orders: matching.reduce((total: number, row: any) => total + row.orders, 0),
        revenue: matching.reduce((total: number, row: any) => total + row.revenue, 0)
      };
    });

    return apiResponse(200, {
      period: { start_date: period.startDate, end_date: period.endDate },
      inventory_enabled: Boolean(flags.flags['pdv.stock_inventory']),
      summary: {
        gross_sales: Number(summary.gross_sales) || 0,
        paid_orders: Number(summary.paid_orders) || 0,
        units_sold: Number(unitsResult.rows[0]?.units_sold) || 0,
        average_ticket: Number(summary.average_ticket) || 0
      },
      sales_by_day: daily,
      sales_by_weekday: weekdays,
      top_groups: groupsResult.rows.map(numericRow),
      top_products: productsResult.rows.map((row: any) => ({ ...numericRow(row), track_inventory: Number(row.track_inventory) === 1 })),
      attention_products: attentionResult.rows.map(numericRow)
    });
  } catch (error: any) {
    console.error('Erro carregando inteligência de Loja & Operações:', error);
    return apiResponse(500, { message: 'Não foi possível carregar os indicadores da loja.' });
  }
};
