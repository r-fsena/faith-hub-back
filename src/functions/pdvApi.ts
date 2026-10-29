import type { Callback, Context } from 'aws-lambda';
import * as products from './pdv_products';
import * as orders from './pdv_orders';
import * as inventory from './pdv_inventory';
import * as analytics from './pdv_analytics';
import { createDomainApiHandler, DomainRouteMap } from './domainApiRouter';

export const pdvApiRoutes: DomainRouteMap = {
  'GET /PDV/PRODUCTS': products.getProducts,
  'POST /PDV/PRODUCTS': products.createOrUpdateProduct,
  'DELETE /PDV/PRODUCTS/{ID}': products.deleteProduct,
  'POST /PDV/ORDERS': orders.createOrder,
  'GET /PDV/ORDERS': orders.getOrders,
  'PUT /PDV/ORDERS/{ID}/STATUS': orders.updateOrderStatus,
  'GET /PDV/INVENTORY': inventory.getInventory,
  'GET /PDV/INVENTORY/MOVEMENTS': inventory.getMovements,
  'POST /PDV/INVENTORY/MOVEMENTS': inventory.createMovement,
  'PUT /PDV/INVENTORY/{PRODUCTID}/SETTINGS': inventory.updateInventorySettings,
  'GET /PDV/ANALYTICS': analytics.getPdvAnalytics
};

const httpHandler = createDomainApiHandler(pdvApiRoutes);

export async function pdvApiHandler(event: any, context: Context, callback: Callback) {
  if (typeof event?.routeKey !== 'string') {
    return inventory.inventoryHandler(event);
  }
  return httpHandler(event, context, callback);
}
