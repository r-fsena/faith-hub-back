require('dotenv').config();
const crypto = require('crypto');
const { createAdminConnection } = require('./scripts/db-admin.cjs');

const migrationId = '20261103_001_member_import_invitations';
const flag = {
  id: 'ff_global_member_import_invites_v1',
  organizationId: 'global',
  environment: 'all',
  key: 'system.saas_member_import_invitations',
  description: 'Convites de primeiro acesso na importação CSV de membros'
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
        VALUES (?, ?, NULL, ?, ?, 1, 'Acesso e importação', ?, 'Member CSV invitations rollout')
        ON DUPLICATE KEY UPDATE is_enabled = 1, category = VALUES(category), description = VALUES(description), updated_by = VALUES(updated_by)`,
      [flag.id, flag.organizationId, flag.environment, flag.key, flag.description]);
      await connection.query(`INSERT INTO security_audit_logs
        (id, organization_id, user_id, user_email, user_role, action, resource, resource_id, details, status)
        VALUES (UUID(), ?, NULL, 'system@faithhubs.com', 'SYSTEM', 'ENABLE_MEMBER_IMPORT_INVITATIONS',
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
