import { authorizeResource } from '../services/tenantResource';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';
import { evaluateTenantFlags } from '../services/featureFlagService';

const STORE_ADMIN_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER', 'VOLUNTEER'];

// GET /pdv/products
export const getProducts = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const admin = event.queryStringParameters?.admin === 'true' && Boolean(user && (user.isSuperAdmin || STORE_ADMIN_ROLES.includes(user.role)));
    const requestedOrgId = event.queryStringParameters?.organization_id;
    const campusId = event.queryStringParameters?.campus_id;

    const tenantScope = user ? enforceTenant(user, requestedOrgId) : null;
    if (tenantScope && !tenantScope.allowed) return tenantScope.errorResponse!;
    const orgId = tenantScope?.effectiveOrgId || (requestedOrgId || 'org_default');

    let sql: string;
    const params: any[] = [];

    if (campusId && campusId !== 'all') {
      sql = `SELECT p.*,
        COALESCE(b.on_hand_quantity, 0) AS on_hand_quantity,
        COALESCE(b.reserved_quantity, 0) AS reserved_quantity,
        COALESCE(b.on_hand_quantity, 0) - COALESCE(b.reserved_quantity, 0) AS available_quantity,
        COALESCE(b.minimum_stock, 0) AS minimum_stock
        FROM pdv_products p
        LEFT JOIN pdv_inventory_balances b
          ON b.organization_id = p.organization_id AND b.product_id = p.id AND b.campus_id = ?
        WHERE p.organization_id = ?`;
      params.push(campusId, orgId);
    } else {
      sql = `SELECT p.*,
        COALESCE(i.on_hand_quantity, 0) AS on_hand_quantity,
        COALESCE(i.reserved_quantity, 0) AS reserved_quantity,
        COALESCE(i.on_hand_quantity, 0) - COALESCE(i.reserved_quantity, 0) AS available_quantity,
        COALESCE(i.minimum_stock, 0) AS minimum_stock
        FROM pdv_products p
        LEFT JOIN (
          SELECT organization_id, product_id, SUM(on_hand_quantity) AS on_hand_quantity,
                 SUM(reserved_quantity) AS reserved_quantity, SUM(minimum_stock) AS minimum_stock
            FROM pdv_inventory_balances WHERE organization_id = ? GROUP BY organization_id, product_id
        ) i ON i.organization_id = p.organization_id AND i.product_id = p.id
        WHERE p.organization_id = ?`;
      params.push(orgId, orgId);
    }

    if (campusId && campusId !== 'all') {
      sql += ` AND (p.campus_id = ? OR p.campus_id IS NULL)`;
      params.push(campusId);
    }
    if (!admin) {
      sql += ` AND p.status = 'ACTIVE'`;
    }

    sql += ` ORDER BY p.category, p.name`;

    const { rows } = await query(sql, params);

    const parseImages = (raw: any): string[] => {
      if (Array.isArray(raw)) return raw.filter(Boolean);
      if (typeof raw === 'string' && raw.trim()) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed.filter(Boolean);
          return [raw.trim()];
        } catch {
          return [raw.trim()];
        }
      }
      return [];
    };

    const formatted = rows.map((r: any) => {
      const trackInventory = Number(r.track_inventory) === 1;
      const isAvailableForPurchase = Number(r.is_available_for_purchase) === 1;
      const availableQuantity = Number(r.available_quantity) || 0;
      const minimumStock = Number(r.minimum_stock) || 0;
      return {
        ...r,
        price: Number(r.price) || 0,
        track_inventory: trackInventory,
        is_available_for_purchase: isAvailableForPurchase,
        purchase_available: r.status === 'ACTIVE'
          && isAvailableForPurchase
          && (!trackInventory || availableQuantity > minimumStock),
        on_hand_quantity: Number(r.on_hand_quantity) || 0,
        reserved_quantity: Number(r.reserved_quantity) || 0,
        available_quantity: availableQuantity,
        minimum_stock: minimumStock,
        image_urls: parseImages(r.image_urls)
      };
    });

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
    if (body.id) {
      const resource = await authorizeResource({ ...event, headers: { ...event.headers, 'x-organization-id': orgValue } }, 'pdv_products', body.id);
      if ('errorResponse' in resource) return resource.errorResponse;
    }

    const campusValue = body.campus_id || 'campus_sede';

    if (body.track_inventory) {
      const flags = await evaluateTenantFlags(orgValue, campusValue, 'production');
      if (!flags.flags['pdv.stock_inventory']) {
        return apiResponse(403, { error: 'FEATURE_DISABLED', message: 'O controle de estoque não está habilitado para esta organização.' });
      }
    }

    const sku = String(body.sku || '').trim() || null;
    const barcode = String(body.barcode || '').trim() || null;
    const unit = String(body.unit || 'UN').trim().toUpperCase().slice(0, 20) || 'UN';
    const availabilityValue = body.is_available_for_purchase === undefined
      ? null
      : (body.is_available_for_purchase ? 1 : 0);
    const qValues = [
      body.name,
      body.description || null,
      body.price || 0.00,
      body.category || 'Geral',
      sku,
      barcode,
      unit,
      body.track_inventory ? 1 : 0,
      availabilityValue,
      body.image_urls ? JSON.stringify(body.image_urls) : '[]',
      body.status || 'DRAFT'
    ];

    if (isUpdate) {
      const uQ = `UPDATE pdv_products SET name=?, description=?, price=?, category=?, sku=?, barcode=?, unit=?, track_inventory=?, is_available_for_purchase=COALESCE(?, is_available_for_purchase), image_urls=?, status=?, campus_id=? WHERE id=? AND organization_id=?`;
      await query(uQ, [...qValues, campusValue, id, orgValue]);
    } else {
      const iQ = `INSERT INTO pdv_products (name, description, price, category, sku, barcode, unit, track_inventory, is_available_for_purchase, image_urls, status, organization_id, campus_id, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      const insertValues = [...qValues];
      insertValues[8] = availabilityValue ?? 1;
      await query(iQ, [...insertValues, orgValue, campusValue, id]);
    }

    await logSecurityEvent({
      organizationId: orgValue,
      user: auth.user,
      action: isUpdate ? 'UPDATE_PDV_PRODUCT' : 'CREATE_PDV_PRODUCT',
      resource: 'pdv_products',
      resourceId: id,
      details: {
        name: body.name,
        price: body.price,
        sku,
        barcode,
        unit,
        track_inventory: Boolean(body.track_inventory),
        is_available_for_purchase: availabilityValue === null ? 'UNCHANGED' : Boolean(availabilityValue)
      },
      event
    });

    return apiResponse(isUpdate ? 200 : 201, { message: 'Produto salvo com sucesso!', id });
  } catch (err: any) {
    if (err?.code === 'ER_DUP_ENTRY') return apiResponse(409, { error: 'DUPLICATE_SKU', message: 'Já existe um produto com este SKU nesta organização.' });
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

    // Produtos com pedidos e movimentações precisam permanecer para preservar a trilha de auditoria.
    await query(`UPDATE pdv_products SET status = 'INACTIVE', updated_at = NOW() WHERE id = ? AND organization_id = ?`, [id, tenantCheck.effectiveOrgId]);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'ARCHIVE_PDV_PRODUCT',
      resource: 'pdv_products',
      resourceId: id,
      details: { name: rows[0].name },
      event
    });

    return apiResponse(200, { message: 'Produto desativado com sucesso' });
  } catch (err: any) {
    return apiResponse(500, { error: 'Erro ao excluir produto' });
  }
};
