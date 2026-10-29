require('dotenv').config();
const crypto = require('crypto');
const { createAdminConnection } = require('./scripts/db-admin.cjs');

const migrationId = '20261028_012_pdv_sales_analytics';
const definition = 'DATETIME NULL AFTER payment_status';
const indexName = 'idx_pdv_orders_sales_analytics';
const checksum = crypto.createHash('sha256').update(JSON.stringify({
  table: 'pdv_orders',
  column: 'paid_at',
  definition,
  indexName,
  backfillOrderItems: true
})).digest('hex');

async function main() {
  const connection = await createAdminConnection();
  let locked = false;
  try {
    const [lockRows] = await connection.query("SELECT GET_LOCK('faith_hub_schema_migrations', 30) AS acquired");
    locked = Number(lockRows[0].acquired) === 1;
    if (!locked) throw new Error('MIGRATION_LOCK_TIMEOUT');

    const [applied] = await connection.query(
      'SELECT migration_id, checksum, applied_at FROM schema_migrations WHERE migration_id = ?',
      [migrationId]
    );
    if (process.argv.includes('--status')) {
      console.log(JSON.stringify({
        migrationId,
        state: applied.length ? 'APPLIED' : 'PENDING',
        checksumMatches: !applied.length || applied[0].checksum === checksum,
        appliedAt: applied[0]?.applied_at || null
      }));
      return;
    }
    if (applied.length) {
      if (applied[0].checksum !== checksum) throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${migrationId}`);
      console.log(JSON.stringify({ migrationId, state: 'ALREADY_APPLIED' }));
      return;
    }

    const [columns] = await connection.query(
      `SELECT COUNT(*) AS count FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'pdv_orders' AND column_name = 'paid_at'`
    );
    if (Number(columns[0].count) === 0) {
      await connection.query(`ALTER TABLE pdv_orders ADD COLUMN paid_at ${definition}`);
    }
    await connection.query(
      `UPDATE pdv_orders SET paid_at = updated_at
        WHERE payment_status = 'PAID' AND paid_at IS NULL`
    );

    const [indexes] = await connection.query(
      `SELECT COUNT(*) AS count FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'pdv_orders' AND index_name = ?`,
      [indexName]
    );
    if (Number(indexes[0].count) === 0) {
      await connection.query(
        `ALTER TABLE pdv_orders ADD INDEX ${indexName}
          (organization_id, campus_id, payment_status, status, paid_at)`
      );
    }

    // Recupera o detalhamento histórico dos pedidos anteriores à fundação do estoque.
    // A migração é global por definição, mas cada INSERT mantém organização, pedido e produto no mesmo tenant.
    const [legacyOrders] = await connection.query(
      `SELECT o.id, o.organization_id, COALESCE(o.campus_id, 'campus_sede') AS campus_id, o.items_json
         FROM pdv_orders o
        WHERE o.organization_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM pdv_order_items i
             WHERE i.organization_id = o.organization_id AND i.order_id = o.id
          )`
    );
    let backfilledItems = 0;
    for (const order of legacyOrders) {
      let items = order.items_json;
      try { if (typeof items === 'string') items = JSON.parse(items); } catch { items = []; }
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const productId = String(item?.id || '');
        const itemQuantity = Number(item?.qty || item?.quantity || 0);
        const unitPrice = Number(item?.price || 0);
        if (!productId || !Number.isFinite(itemQuantity) || itemQuantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) continue;
        const [result] = await connection.query(
          `INSERT IGNORE INTO pdv_order_items
            (id, organization_id, campus_id, order_id, product_id, product_name, quantity,
             unit_price, line_total, observation, track_inventory)
           SELECT UUID(), o.organization_id, ?, o.id, p.id, COALESCE(NULLIF(?, ''), p.name), ?, ?, ?, ?, p.track_inventory
             FROM pdv_orders o
             INNER JOIN pdv_products p ON p.id = ? AND p.organization_id = o.organization_id
            WHERE o.id = ? AND o.organization_id = ?`,
          [
            order.campus_id, String(item?.name || '').slice(0, 150), itemQuantity, unitPrice,
            itemQuantity * unitPrice, item?.obs ? String(item.obs).slice(0, 500) : null,
            productId, order.id, order.organization_id
          ]
        );
        backfilledItems += Number(result.affectedRows) || 0;
      }
    }

    await connection.beginTransaction();
    try {
      await connection.query(`INSERT INTO security_audit_logs
        (id, organization_id, user_id, user_email, user_role, action, resource, resource_id, details, status)
        VALUES (UUID(), 'org_default', NULL, 'system@faithhubs.com', 'SYSTEM',
          'ENABLE_PDV_SALES_ANALYTICS', 'schema_migrations', ?, ?, 'SUCCESS')`,
      [migrationId, JSON.stringify({ table: 'pdv_orders', column: 'paid_at', index: indexName, backfilled_items: backfilledItems })]);
      await connection.query('INSERT INTO schema_migrations (migration_id, checksum) VALUES (?, ?)', [migrationId, checksum]);
      await connection.commit();
      console.log(JSON.stringify({ migrationId, state: 'APPLIED', column: 'paid_at', index: indexName, backfilledItems }));
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");
    await connection.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
