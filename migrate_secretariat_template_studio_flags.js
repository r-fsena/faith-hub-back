require('dotenv').config();
const crypto = require('crypto');
const { createAdminConnection } = require('./scripts/db-admin.cjs');

const migrationId = '20261028_005_secretariat_template_studio_flags';
const flag = {
  id: 'ff_org_default_sec_pdf_v1',
  organizationId: 'org_default',
  environment: 'production',
  key: 'secretariat.document_pdf',
  description: 'Geração e download de documentos oficiais em PDF'
};
const checksum = crypto.createHash('sha256').update(JSON.stringify(flag)).digest('hex');

async function main() {
  const connection = await createAdminConnection();
  let locked = false;
  try {
    const [lockRows] = await connection.query("SELECT GET_LOCK('faith_hub_schema_migrations', 30) AS acquired");
    locked = Number(lockRows[0].acquired) === 1;
    if (!locked) throw new Error('MIGRATION_LOCK_TIMEOUT');
    const [applied] = await connection.query('SELECT migration_id, checksum, applied_at FROM schema_migrations WHERE migration_id = ?', [migrationId]);
    if (process.argv.includes('--status')) {
      console.log(JSON.stringify({ migrationId, state: applied.length ? 'APPLIED' : 'PENDING', checksumMatches: !applied.length || applied[0].checksum === checksum, appliedAt: applied[0]?.applied_at || null }));
      return;
    }
    if (applied.length) {
      if (applied[0].checksum !== checksum) throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${migrationId}`);
      console.log(JSON.stringify({ migrationId, state: 'ALREADY_APPLIED' }));
      return;
    }
    await connection.beginTransaction();
    try {
      await connection.query(`INSERT INTO tenant_feature_flags
        (id, organization_id, campus_id, environment, feature_key, is_enabled, category, description, updated_by)
        VALUES (?, ?, NULL, ?, ?, 1, 'Secretaria', ?, 'Secretariat Template Studio Flag Repair')
        ON DUPLICATE KEY UPDATE is_enabled = 1, category = VALUES(category), description = VALUES(description), updated_by = VALUES(updated_by)`,
      [flag.id, flag.organizationId, flag.environment, flag.key, flag.description]);
      await connection.query(`INSERT INTO security_audit_logs
        (id, organization_id, user_id, user_email, user_role, action, resource, resource_id, details, status)
        VALUES (UUID(), ?, NULL, 'system@faithhubs.com', 'SYSTEM', 'REPAIR_SECRETARIAT_TEMPLATE_FLAGS',
          'tenant_feature_flags', ?, ?, 'SUCCESS')`,
      [flag.organizationId, migrationId, JSON.stringify({ feature_key: flag.key, enabled: true })]);
      await connection.query('INSERT INTO schema_migrations (migration_id, checksum) VALUES (?, ?)', [migrationId, checksum]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    console.log(JSON.stringify({ migrationId, state: 'APPLIED', featureKey: flag.key }));
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");
    await connection.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
