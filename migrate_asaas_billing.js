require('dotenv').config();
const crypto = require('crypto');
const { createAdminConnection } = require('./scripts/db-admin.cjs');

const migrationId = '20261026_002_asaas_billing_hardening';

const tableStatements = [
  `CREATE TABLE IF NOT EXISTS asaas_webhook_events (
    id VARCHAR(100) PRIMARY KEY,
    event_type VARCHAR(80) NOT NULL,
    payment_id VARCHAR(100) NULL,
    subscription_id VARCHAR(100) NULL,
    checkout_id VARCHAR(100) NULL,
    payload_hash CHAR(64) NOT NULL,
    status ENUM('RECEIVED','QUEUED','PROCESSING','PROCESSED','FAILED') NOT NULL DEFAULT 'RECEIVED',
    attempts INT NOT NULL DEFAULT 0,
    last_error VARCHAR(500) NULL,
    received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_asaas_events_status (status, received_at),
    INDEX idx_asaas_events_payment (payment_id),
    INDEX idx_asaas_events_subscription (subscription_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS saas_provisioning_jobs (
    id VARCHAR(100) PRIMARY KEY,
    proposal_id VARCHAR(36) NOT NULL,
    source_event_id VARCHAR(100) NOT NULL,
    organization_id VARCHAR(50) NULL,
    status ENUM('PENDING','PROCESSING','COMPLETED','FAILED') NOT NULL DEFAULT 'PENDING',
    attempts INT NOT NULL DEFAULT 0,
    last_error VARCHAR(500) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    UNIQUE KEY uq_provisioning_source_event (source_event_id),
    INDEX idx_provisioning_proposal (proposal_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

const columnChanges = {
  saas_proposals: [
    ['asaas_checkout_id', 'VARCHAR(100) NULL'],
    ['asaas_checkout_url', 'TEXT NULL'],
    ['billing_status', "VARCHAR(40) NOT NULL DEFAULT 'NOT_STARTED'"],
    ['billing_external_reference', 'VARCHAR(150) NULL'],
    ['billing_environment', 'VARCHAR(20) NULL'],
    ['billing_error', 'VARCHAR(500) NULL']
  ],
  saas_subscriptions: [
    ['external_reference', 'VARCHAR(150) NULL'],
    ['provider_status', 'VARCHAR(50) NULL'],
    ['last_payment_id', 'VARCHAR(100) NULL'],
    ['last_event_id', 'VARCHAR(100) NULL'],
    ['is_verified', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['verified_at', 'DATETIME NULL']
  ],
  saas_invoices: [
    ['asaas_payment_id', 'VARCHAR(100) NULL'],
    ['external_reference', 'VARCHAR(150) NULL'],
    ['provider_status', 'VARCHAR(50) NULL'],
    ['billing_type', 'VARCHAR(30) NULL'],
    ['invoice_url', 'TEXT NULL'],
    ['bank_slip_url', 'TEXT NULL'],
    ['last_event_id', 'VARCHAR(100) NULL']
  ]
};

async function hasColumn(connection, table, column) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function hasIndex(connection, table, index) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, index]
  );
  return rows.length > 0;
}

async function migrate() {
  const connection = await createAdminConnection();
  let locked = false;
  const checksum = crypto.createHash('sha256')
    .update(JSON.stringify({ tableStatements, columnChanges }))
    .digest('hex');

  try {
    const [lockRows] = await connection.query(`SELECT GET_LOCK('faith_hub_schema_migrations', 30) AS acquired`);
    locked = Number(lockRows[0].acquired) === 1;
    if (!locked) throw new Error('MIGRATION_LOCK_TIMEOUT');

    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id VARCHAR(150) PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

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

    for (const statement of tableStatements) await connection.query(statement);
    for (const [table, columns] of Object.entries(columnChanges)) {
      for (const [column, definition] of columns) {
        if (!(await hasColumn(connection, table, column))) {
          await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
        }
      }
    }

    await connection.query('ALTER TABLE saas_invoices MODIFY organization_id VARCHAR(50) NULL');
    await connection.query('ALTER TABLE saas_invoices MODIFY status VARCHAR(30) NOT NULL DEFAULT \'PENDING\'');
    if (!(await hasIndex(connection, 'saas_invoices', 'uq_saas_invoice_asaas_payment'))) {
      await connection.query('ALTER TABLE saas_invoices ADD UNIQUE KEY uq_saas_invoice_asaas_payment (asaas_payment_id)');
    }
    if (!(await hasIndex(connection, 'saas_proposals', 'uq_saas_proposal_checkout'))) {
      await connection.query('ALTER TABLE saas_proposals ADD UNIQUE KEY uq_saas_proposal_checkout (asaas_checkout_id)');
    }

    await connection.beginTransaction();
    try {
      await connection.query(`INSERT INTO tenant_feature_flags
        (id, organization_id, campus_id, environment, feature_key, is_enabled, category, description, updated_by)
        VALUES ('ff_global_saas_checkout', 'global', NULL, 'all', 'system.saas_billing_checkout', 0,
          'Sistema', 'Checkout recorrente hospedado e conciliado pelo Asaas', 'migration')
        ON DUPLICATE KEY UPDATE is_enabled = 0, description = VALUES(description), updated_by = 'migration'`);

      const [legacySubs] = await connection.query(`UPDATE saas_subscriptions
        SET status = 'LEGACY_UNVERIFIED', provider_status = 'LEGACY_UNVERIFIED', is_verified = 0
        WHERE is_verified = 0 AND provider_status IS NULL`);
      const [legacyInvoices] = await connection.query(`UPDATE saas_invoices
        SET provider_status = 'LEGACY_UNVERIFIED'
        WHERE asaas_payment_id IS NULL AND provider_status IS NULL`);
      const [legacyProposals] = await connection.query(`UPDATE saas_proposals
        SET billing_status = 'LEGACY_UNVERIFIED', billing_environment = 'legacy'
        WHERE created_organization_id IS NOT NULL
          AND billing_status = 'NOT_STARTED'`);

      await connection.query(`INSERT INTO security_audit_logs
        (id, organization_id, user_id, user_email, user_role, action, resource, resource_id, details, status)
        VALUES (UUID(), 'org_default', NULL, 'system@faithhubs.com', 'SYSTEM',
          'CLASSIFY_LEGACY_ASAAS_RECORDS', 'saas_billing', ?, ?, 'SUCCESS')`, [
        migrationId,
        JSON.stringify({
          subscriptions: legacySubs.affectedRows,
          invoices: legacyInvoices.affectedRows,
          proposals: legacyProposals.affectedRows,
          environmentsPreserved: true
        })
      ]);
      await connection.query(
        'INSERT INTO schema_migrations (migration_id, checksum) VALUES (?, ?)',
        [migrationId, checksum]
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }

    console.log(JSON.stringify({ migrationId, state: 'APPLIED' }));
  } finally {
    if (locked) await connection.query(`SELECT RELEASE_LOCK('faith_hub_schema_migrations')`);
    await connection.end();
  }
}

migrate().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
