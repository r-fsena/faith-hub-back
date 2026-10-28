require('dotenv').config();
const crypto = require('crypto');
const { createAdminConnection } = require('./scripts/db-admin.cjs');

const migrationId = '20261028_006_studio_experience';
const tableSql = `CREATE TABLE IF NOT EXISTS studio_user_preferences (
  id VARCHAR(36) NOT NULL,
  organization_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  onboarding_steps JSON NULL,
  onboarding_dismissed TINYINT(1) NOT NULL DEFAULT 0,
  favorite_tabs JSON NULL,
  recent_tabs JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_studio_preferences_org_user (organization_id, user_id),
  KEY idx_studio_preferences_org_user (organization_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
const flags = [
  ['studio.guided_onboarding', 'Onboarding guiado e checklist de implantação'],
  ['studio.global_search', 'Busca global segura por telas, ações, pessoas e documentos'],
  ['studio.personalized_navigation', 'Favoritos, itens recentes e navegação personalizada']
];
const checksum = crypto.createHash('sha256').update(JSON.stringify({ tableSql, flags })).digest('hex');

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
      console.log(JSON.stringify({ migrationId, state: applied.length ? 'APPLIED' : 'PENDING', checksumMatches: !applied.length || applied[0].checksum === checksum, appliedAt: applied[0]?.applied_at || null }));
      return;
    }
    if (applied.length) {
      if (applied[0].checksum !== checksum) throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${migrationId}`);
      console.log(JSON.stringify({ migrationId, state: 'ALREADY_APPLIED' }));
      return;
    }

    await connection.query(tableSql);
    await connection.beginTransaction();
    try {
      for (const [index, [key, description]] of flags.entries()) {
        await connection.query(`INSERT INTO tenant_feature_flags
          (id, organization_id, campus_id, environment, feature_key, is_enabled, category, description, updated_by)
          VALUES (?, 'global', NULL, 'all', ?, 0, 'Experiência do Studio', ?, 'Studio Experience Migration')
          ON DUPLICATE KEY UPDATE category = VALUES(category), description = VALUES(description)`,
        [`ff_g_studio_${index + 1}_v1`, key, description]);
        await connection.query(`INSERT INTO tenant_feature_flags
          (id, organization_id, campus_id, environment, feature_key, is_enabled, category, description, updated_by)
          VALUES (?, 'org_default', NULL, 'production', ?, 1, 'Experiência do Studio', ?, 'Studio Experience Migration')
          ON DUPLICATE KEY UPDATE is_enabled = 1, category = VALUES(category), description = VALUES(description), updated_by = VALUES(updated_by)`,
        [`ff_o_studio_${index + 1}_v1`, key, description]);
      }
      await connection.query(`INSERT INTO security_audit_logs
        (id, organization_id, user_id, user_email, user_role, action, resource, resource_id, details, status)
        VALUES (UUID(), 'org_default', NULL, 'system@faithhubs.com', 'SYSTEM',
          'ENABLE_STUDIO_EXPERIENCE', 'schema_migrations', ?, ?, 'SUCCESS')`,
      [migrationId, JSON.stringify({ flags: flags.map(([key]) => key), preferences: true })]);
      await connection.query('INSERT INTO schema_migrations (migration_id, checksum) VALUES (?, ?)', [migrationId, checksum]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    console.log(JSON.stringify({ migrationId, state: 'APPLIED', flags: flags.map(([key]) => key) }));
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");
    await connection.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
