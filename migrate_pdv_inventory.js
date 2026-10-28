require('dotenv').config();
const crypto = require('crypto');
const { createAdminConnection } = require('./scripts/db-admin.cjs');

const migrationId = '20261028_009_pdv_inventory_foundation';
const productColumns = [
  ['sku', "VARCHAR(80) NULL AFTER category"],
  ['barcode', "VARCHAR(120) NULL AFTER sku"],
  ['unit', "VARCHAR(20) NOT NULL DEFAULT 'UN' AFTER barcode"],
  ['track_inventory', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER unit']
];
const productIndexes = [
  ['uq_pdv_products_org_sku', 'UNIQUE INDEX uq_pdv_products_org_sku (organization_id, sku)'],
  ['idx_pdv_products_org_barcode', 'INDEX idx_pdv_products_org_barcode (organization_id, barcode)']
];

const statements = [
  `CREATE TABLE IF NOT EXISTS pdv_inventory_balances (
    id VARCHAR(36) NOT NULL,
    organization_id VARCHAR(36) NOT NULL,
    campus_id VARCHAR(36) NOT NULL,
    product_id VARCHAR(36) NOT NULL,
    on_hand_quantity DECIMAL(12,3) NOT NULL DEFAULT 0,
    reserved_quantity DECIMAL(12,3) NOT NULL DEFAULT 0,
    minimum_stock DECIMAL(12,3) NOT NULL DEFAULT 0,
    allow_negative TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_pdv_inventory_balance (organization_id, campus_id, product_id),
    KEY idx_pdv_inventory_alerts (organization_id, campus_id, on_hand_quantity, minimum_stock),
    CONSTRAINT fk_pdv_inventory_balance_product FOREIGN KEY (product_id) REFERENCES pdv_products(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS pdv_order_items (
    id VARCHAR(36) NOT NULL,
    organization_id VARCHAR(36) NOT NULL,
    campus_id VARCHAR(36) NOT NULL,
    order_id VARCHAR(36) NOT NULL,
    product_id VARCHAR(36) NOT NULL,
    product_name VARCHAR(150) NOT NULL,
    quantity DECIMAL(12,3) NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    line_total DECIMAL(12,2) NOT NULL,
    observation VARCHAR(500) NULL,
    track_inventory TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_pdv_order_item_product (organization_id, order_id, product_id),
    KEY idx_pdv_order_items_order (organization_id, campus_id, order_id),
    KEY idx_pdv_order_items_product (organization_id, campus_id, product_id),
    CONSTRAINT fk_pdv_order_items_order FOREIGN KEY (order_id) REFERENCES pdv_orders(id),
    CONSTRAINT fk_pdv_order_items_product FOREIGN KEY (product_id) REFERENCES pdv_products(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS pdv_inventory_reservations (
    id VARCHAR(36) NOT NULL,
    organization_id VARCHAR(36) NOT NULL,
    campus_id VARCHAR(36) NOT NULL,
    order_id VARCHAR(36) NOT NULL,
    product_id VARCHAR(36) NOT NULL,
    quantity DECIMAL(12,3) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    expires_at DATETIME NOT NULL,
    committed_at DATETIME NULL,
    released_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_pdv_inventory_reservation (organization_id, order_id, product_id),
    KEY idx_pdv_inventory_reservation_expiry (status, expires_at),
    KEY idx_pdv_inventory_reservation_product (organization_id, campus_id, product_id, status),
    CONSTRAINT fk_pdv_inventory_reservation_order FOREIGN KEY (order_id) REFERENCES pdv_orders(id),
    CONSTRAINT fk_pdv_inventory_reservation_product FOREIGN KEY (product_id) REFERENCES pdv_products(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS pdv_inventory_movements (
    id VARCHAR(36) NOT NULL,
    organization_id VARCHAR(36) NOT NULL,
    campus_id VARCHAR(36) NOT NULL,
    product_id VARCHAR(36) NOT NULL,
    movement_type VARCHAR(40) NOT NULL,
    quantity_delta DECIMAL(12,3) NOT NULL DEFAULT 0,
    reserved_delta DECIMAL(12,3) NOT NULL DEFAULT 0,
    previous_on_hand DECIMAL(12,3) NOT NULL,
    new_on_hand DECIMAL(12,3) NOT NULL,
    previous_reserved DECIMAL(12,3) NOT NULL,
    new_reserved DECIMAL(12,3) NOT NULL,
    reason VARCHAR(255) NOT NULL,
    notes TEXT NULL,
    reference_type VARCHAR(40) NULL,
    reference_id VARCHAR(36) NULL,
    idempotency_key VARCHAR(190) NOT NULL,
    created_by VARCHAR(36) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_pdv_inventory_idempotency (organization_id, idempotency_key),
    KEY idx_pdv_inventory_movements_product (organization_id, campus_id, product_id, created_at),
    KEY idx_pdv_inventory_movements_reference (organization_id, reference_type, reference_id),
    CONSTRAINT fk_pdv_inventory_movement_product FOREIGN KEY (product_id) REFERENCES pdv_products(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

const checksum = crypto.createHash('sha256').update(JSON.stringify({ productColumns, productIndexes, statements })).digest('hex');

async function main() {
  const connection = await createAdminConnection();
  let locked = false;
  try {
    const [lockRows] = await connection.query("SELECT GET_LOCK('faith_hub_schema_migrations', 30) AS acquired");
    locked = Number(lockRows[0].acquired) === 1;
    if (!locked) throw new Error('MIGRATION_LOCK_TIMEOUT');
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id VARCHAR(150) PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const [applied] = await connection.query(
      'SELECT migration_id, checksum, applied_at FROM schema_migrations WHERE migration_id = ?', [migrationId]
    );
    if (process.argv.includes('--status')) {
      console.log(JSON.stringify({ migrationId, state: applied.length ? 'APPLIED' : 'PENDING', checksumMatches: !applied.length || applied[0].checksum === checksum, appliedAt: applied[0]?.applied_at || null }));
      return;
    }
    if (applied.length) {
      if (applied[0].checksum !== checksum) throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${migrationId}`);
      console.log(JSON.stringify({ migrationId, state: 'ALREADY_APPLIED' }));
      return;
    }
    for (const [column, definition] of productColumns) {
      const [columnRows] = await connection.query(
        `SELECT COUNT(*) AS count FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'pdv_products' AND column_name = ?`, [column]
      );
      if (Number(columnRows[0].count) === 0) await connection.query(`ALTER TABLE pdv_products ADD COLUMN ${column} ${definition}`);
    }
    for (const [indexName, definition] of productIndexes) {
      const [indexRows] = await connection.query(
        `SELECT COUNT(*) AS count FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'pdv_products' AND index_name = ?`, [indexName]
      );
      if (Number(indexRows[0].count) === 0) await connection.query(`ALTER TABLE pdv_products ADD ${definition}`);
    }
    for (const statement of statements) await connection.query(statement);
    await connection.beginTransaction();
    try {
      await connection.query(`INSERT INTO tenant_feature_flags
        (id, organization_id, campus_id, environment, feature_key, is_enabled, category, description, updated_by)
        VALUES ('flag_global_pdv_stock_inventory_v2', 'global', NULL, 'all', 'pdv.stock_inventory', 0, 'PDV',
          'Estoque por unidade, movimentações, reservas e baixa automática de vendas', 'PDV Inventory Migration')
        ON DUPLICATE KEY UPDATE category = VALUES(category), description = VALUES(description)`);
      await connection.query(`INSERT INTO security_audit_logs
        (id, organization_id, user_id, user_email, user_role, action, resource, resource_id, details, status)
        VALUES (UUID(), 'org_default', NULL, 'system@faithhubs.com', 'SYSTEM',
          'CREATE_PDV_INVENTORY_FOUNDATION', 'schema_migrations', ?, ?, 'SUCCESS')`,
      [migrationId, JSON.stringify({ tables: 4, productFields: ['sku', 'barcode', 'unit', 'track_inventory'] })]);
      await connection.query('INSERT INTO schema_migrations (migration_id, checksum) VALUES (?, ?)', [migrationId, checksum]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    console.log(JSON.stringify({ migrationId, state: 'APPLIED', tables: statements.length, productColumns: productColumns.length }));
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");
    await connection.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
