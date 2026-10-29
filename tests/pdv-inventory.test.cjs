const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(
  fs.readFileSync(filename, 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }
).outputText, filename);

const {
  InventoryError,
  reserveOrderInventory,
  transitionOrderInventory
} = require('../src/services/pdvInventoryService.ts');

function inventoryConnection(initialOnHand = 10, minimumStock = 0) {
  const state = {
    balance: { id: 'balance-a', on_hand_quantity: initialOnHand, reserved_quantity: 0, minimum_stock: minimumStock, allow_negative: 0 },
    reservations: [],
    movements: []
  };
  const connection = {
    query: async (sql, params = []) => {
      if (sql.includes('INSERT IGNORE INTO pdv_inventory_balances')) return [{ affectedRows: 0 }];
      if (sql.includes('FROM pdv_inventory_balances') && sql.includes('FOR UPDATE')) return [[{ ...state.balance }]];
      if (sql.includes('UPDATE pdv_inventory_balances SET on_hand_quantity = ?, reserved_quantity = ?')) {
        state.balance.on_hand_quantity = params[0]; state.balance.reserved_quantity = params[1]; return [{ affectedRows: 1 }];
      }
      if (sql.includes('UPDATE pdv_inventory_balances') && sql.includes('SET reserved_quantity = ?')) {
        state.balance.reserved_quantity = params[0]; return [{ affectedRows: 1 }];
      }
      if (sql.includes('UPDATE pdv_inventory_balances SET on_hand_quantity = ?')) {
        state.balance.on_hand_quantity = params[0]; return [{ affectedRows: 1 }];
      }
      if (sql.includes('INSERT INTO pdv_inventory_reservations')) {
        state.reservations.push({ id: params[0], organization_id: params[1], campus_id: params[2], order_id: params[3], product_id: params[4], quantity: params[5], status: 'ACTIVE' });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('FROM pdv_inventory_reservations') && sql.includes('FOR UPDATE')) {
        return [state.reservations.filter(item => item.organization_id === params[0] && item.order_id === params[1]).map(item => ({ ...item }))];
      }
      if (sql.includes("SET status = 'COMMITTED'")) {
        state.reservations.find(item => item.id === params[0]).status = 'COMMITTED'; return [{ affectedRows: 1 }];
      }
      if (sql.includes("SET status = 'RELEASED'")) {
        state.reservations.find(item => item.id === params[0]).status = 'RELEASED'; return [{ affectedRows: 1 }];
      }
      if (sql.includes("SET status = 'REVERSED'")) {
        state.reservations.find(item => item.id === params[0]).status = 'REVERSED'; return [{ affectedRows: 1 }];
      }
      if (sql.includes('INSERT IGNORE INTO pdv_inventory_movements')) {
        state.movements.push({ type: params[4], quantityDelta: params[5], reservedDelta: params[6], key: params[15] });
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL in inventory test: ${sql}`);
    }
  };
  return { state, connection };
}

test('inventory reserves, commits and reverses a paid order without duplicate stock changes', async () => {
  const { state, connection } = inventoryConnection(10);
  const common = { organizationId: 'org-a', campusId: 'campus-a', orderId: 'order-a', actorId: 'member-a' };
  await reserveOrderInventory(connection, { ...common, expiresAt: new Date(Date.now() + 60_000), items: [{ productId: 'product-a', quantity: 2, trackInventory: true }] });
  assert.equal(state.balance.on_hand_quantity, 10);
  assert.equal(state.balance.reserved_quantity, 2);
  assert.equal(state.reservations[0].status, 'ACTIVE');

  await transitionOrderInventory(connection, { organizationId: 'org-a', orderId: 'order-a', transition: 'COMMIT', actorId: 'admin-a' });
  assert.equal(state.balance.on_hand_quantity, 8);
  assert.equal(state.balance.reserved_quantity, 0);
  assert.equal(state.reservations[0].status, 'COMMITTED');

  await transitionOrderInventory(connection, { organizationId: 'org-a', orderId: 'order-a', transition: 'COMMIT', actorId: 'admin-a' });
  assert.equal(state.balance.on_hand_quantity, 8, 'repeated payment confirmation must not double-decrement stock');

  await transitionOrderInventory(connection, { organizationId: 'org-a', orderId: 'order-a', transition: 'CANCEL', actorId: 'admin-a' });
  assert.equal(state.balance.on_hand_quantity, 10);
  assert.equal(state.reservations[0].status, 'REVERSED');

  await transitionOrderInventory(connection, { organizationId: 'org-a', orderId: 'order-a', transition: 'CANCEL', actorId: 'admin-a' });
  assert.equal(state.balance.on_hand_quantity, 10, 'repeated cancellation must not double-restock');
  assert.deepEqual(state.movements.map(item => item.type), ['RESERVATION', 'SALE', 'SALE_REVERSAL']);
});

test('inventory refuses a reservation above the available tenant-campus balance', async () => {
  const { state, connection } = inventoryConnection(1);
  await assert.rejects(
    reserveOrderInventory(connection, {
      organizationId: 'org-a', campusId: 'campus-a', orderId: 'order-a', expiresAt: new Date(Date.now() + 60_000),
      items: [{ productId: 'product-a', quantity: 2, trackInventory: true }]
    }),
    error => error instanceof InventoryError && error.code === 'INSUFFICIENT_STOCK'
  );
  assert.equal(state.balance.on_hand_quantity, 1);
  assert.equal(state.balance.reserved_quantity, 0);
  assert.equal(state.reservations.length, 0);
});

test('inventory preserves the configured minimum stock during a sale reservation', async () => {
  const { state, connection } = inventoryConnection(6, 5);

  await reserveOrderInventory(connection, {
    organizationId: 'org-a', campusId: 'campus-a', orderId: 'order-a', expiresAt: new Date(Date.now() + 60_000),
    items: [{ productId: 'product-a', quantity: 1, trackInventory: true }]
  });
  assert.equal(state.balance.reserved_quantity, 1, 'the last sellable unit may be reserved');

  await assert.rejects(
    reserveOrderInventory(connection, {
      organizationId: 'org-a', campusId: 'campus-a', orderId: 'order-b', expiresAt: new Date(Date.now() + 60_000),
      items: [{ productId: 'product-a', quantity: 1, trackInventory: true }]
    }),
    error => error instanceof InventoryError
      && error.code === 'INSUFFICIENT_STOCK'
      && error.message.includes('Estoque mínimo atingido')
  );
  assert.equal(state.balance.reserved_quantity, 1);
  assert.equal(state.reservations.length, 1);
});
