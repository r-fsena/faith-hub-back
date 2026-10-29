require('dotenv').config();
const crypto = require('crypto');
const { createAdminConnection } = require('./scripts/db-admin.cjs');

const migrationId = '20261028_011_pdv_product_purchase_availability';
const definition = "TINYINT(1) NOT NULL DEFAULT 1 AFTER track_inventory";
const checksum = crypto.createHash('sha256').update(JSON.stringify({
  table: 'pdv_products',
  column: 'is_available_for_purchase',
  definition
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
        WHERE table_schema = DATABASE() AND table_name = 'pdv_products'
          AND column_name = 'is_available_for_purchase'`
    );
    if (Number(columns[0].count) === 0) {
      await connection.query(`ALTER TABLE pdv_products ADD COLUMN is_available_for_purchase ${definition}`);
    }

    await connection.beginTransaction();
    try {
      await connection.query(`INSERT INTO security_audit_logs
        (id, organization_id, user_id, user_email, user_role, action, resource, resource_id, details, status)
        VALUES (UUID(), 'org_default', NULL, 'system@faithhubs.com', 'SYSTEM',
          'ADD_PDV_PRODUCT_PURCHASE_AVAILABILITY', 'schema_migrations', ?, ?, 'SUCCESS')`,
      [migrationId, JSON.stringify({ table: 'pdv_products', column: 'is_available_for_purchase', default: true })]);
      await connection.query('INSERT INTO schema_migrations (migration_id, checksum) VALUES (?, ?)', [migrationId, checksum]);
      await connection.commit();
      console.log(JSON.stringify({ migrationId, state: 'APPLIED', column: 'is_available_for_purchase' }));
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
