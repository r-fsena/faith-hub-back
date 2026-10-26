require('dotenv').config();
const crypto = require('crypto');
const { createAdminConnection } = require('./scripts/db-admin.cjs');

const migrationId = '20261026_003_asaas_checkout_customer_correlation';
const statements = [
  'ALTER TABLE asaas_webhook_events ADD COLUMN customer_id VARCHAR(100) NULL AFTER checkout_id',
  'ALTER TABLE asaas_webhook_events ADD INDEX idx_asaas_events_customer (customer_id)'
];
const checksum = crypto.createHash('sha256').update(JSON.stringify(statements)).digest('hex');

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
    const [columns] = await connection.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'asaas_webhook_events' AND column_name = 'customer_id'`);
    if (!columns.length) await connection.query(statements[0]);
    const [indexes] = await connection.query(`SELECT index_name FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'asaas_webhook_events' AND index_name = 'idx_asaas_events_customer'`);
    if (!indexes.length) await connection.query(statements[1]);
    await connection.beginTransaction();
    try {
      await connection.query(`INSERT INTO security_audit_logs
        (id, organization_id, user_id, user_email, user_role, action, resource, resource_id, details, status)
        VALUES (UUID(), 'org_default', NULL, 'system@faithhubs.com', 'SYSTEM',
          'ADD_ASAAS_CHECKOUT_CUSTOMER_CORRELATION', 'schema_migrations', ?, ?, 'SUCCESS')`, [
        migrationId,
        JSON.stringify({ customerCorrelation: true, tenantResolution: 'checkout_customer_then_unique_proposal' })
      ]);
      await connection.query('INSERT INTO schema_migrations (migration_id, checksum) VALUES (?, ?)', [migrationId, checksum]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    console.log(JSON.stringify({ migrationId, state: 'APPLIED' }));
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");
    await connection.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
