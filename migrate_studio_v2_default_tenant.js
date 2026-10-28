require('dotenv').config();
const crypto = require('crypto');
const { createAdminConnection } = require('./scripts/db-admin.cjs');

const migrationId = '20261028_008_studio_v2_default_tenant';
const tenant = { id: 'org_default', name: 'Igreja Viva' };
const feature = 'studio.context_navigation_v2';
const configPayload = { default_version: 'v2', rollout: 'test_tenant' };
const checksum = crypto.createHash('sha256').update(JSON.stringify({ tenant, feature, configPayload })).digest('hex');

async function main() {
  const connection = await createAdminConnection();
  let locked = false;
  try {
    const [lockRows] = await connection.query("SELECT GET_LOCK('faith_hub_schema_migrations', 30) AS acquired");
    locked = Number(lockRows[0].acquired) === 1;
    if (!locked) throw new Error('MIGRATION_LOCK_TIMEOUT');

    const [applied] = await connection.query(
      'SELECT migration_id, checksum, applied_at FROM schema_migrations WHERE migration_id = ?', [migrationId]
    );
    if (process.argv.includes('--status')) {
      console.log(JSON.stringify({
        migrationId,
        tenant,
        state: applied.length ? 'APPLIED' : 'PENDING',
        checksumMatches: !applied.length || applied[0].checksum === checksum,
        appliedAt: applied[0]?.applied_at || null
      }));
      return;
    }
    if (applied.length) {
      if (applied[0].checksum !== checksum) throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${migrationId}`);
      console.log(JSON.stringify({ migrationId, state: 'ALREADY_APPLIED', tenant }));
      return;
    }

    await connection.beginTransaction();
    try {
      await connection.query(`INSERT INTO tenant_feature_flags
        (id, organization_id, campus_id, environment, feature_key, is_enabled, config_payload, category, description, updated_by)
        VALUES ('ff_o_studio_nav_v2', ?, NULL, 'production', ?, 1, ?, 'Experiência do Studio',
          'Studio V2 padrão no tenant de teste Igreja Viva', 'Studio V2 Tenant Rollout')
        ON DUPLICATE KEY UPDATE is_enabled = 1, config_payload = VALUES(config_payload),
          category = VALUES(category), description = VALUES(description), updated_by = VALUES(updated_by)`,
      [tenant.id, feature, JSON.stringify(configPayload)]);

      await connection.query(`INSERT INTO security_audit_logs
        (id, organization_id, user_id, user_email, user_role, action, resource, resource_id, details, status)
        VALUES (UUID(), ?, NULL, 'system@faithhubs.com', 'SYSTEM',
          'ENABLE_STUDIO_V2_DEFAULT_FOR_TENANT', 'tenant_feature_flags', ?, ?, 'SUCCESS')`,
      [tenant.id, feature, JSON.stringify({ tenant_name: tenant.name, ...configPayload })]);

      await connection.query('INSERT INTO schema_migrations (migration_id, checksum) VALUES (?, ?)', [migrationId, checksum]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    console.log(JSON.stringify({ migrationId, state: 'APPLIED', tenant, feature, config: configPayload }));
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");
    await connection.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
