require('dotenv').config();
const crypto = require('crypto');
const { createAdminConnection } = require('./scripts/db-admin.cjs');

const migrationId = '20261028_013_content_engagement_analytics';
const tableSql = `CREATE TABLE IF NOT EXISTS content_engagement_events (
  id VARCHAR(36) NOT NULL,
  organization_id VARCHAR(36) NOT NULL,
  campus_id VARCHAR(36) NULL,
  user_id VARCHAR(36) NULL,
  session_hash CHAR(64) NULL,
  content_type ENUM('EVENT','BROADCAST','DEVOTIONAL','STUDY_BOOK','STUDY_CHAPTER') NOT NULL,
  content_id VARCHAR(36) NOT NULL,
  event_type ENUM('OPENED','STARTED','COMPLETED','CTA_CLICKED','NOTE_CREATED','STREAM_STARTED','STREAM_ENDED') NOT NULL,
  source VARCHAR(64) NULL,
  duration_seconds INT UNSIGNED NULL,
  progress_percent DECIMAL(5,2) NULL,
  idempotency_key VARCHAR(100) NOT NULL,
  occurred_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_content_engagement_org_key (organization_id, idempotency_key),
  KEY idx_content_engagement_org_date (organization_id, occurred_at),
  KEY idx_content_engagement_org_content (organization_id, content_type, content_id, occurred_at),
  KEY idx_content_engagement_org_user (organization_id, user_id, occurred_at),
  KEY idx_content_engagement_org_session (organization_id, session_hash, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
const featureKey = 'content.analytics_dashboard';
const checksum = crypto.createHash('sha256').update(JSON.stringify({ tableSql, featureKey })).digest('hex');

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
      const description = 'Inteligência de uso para eventos, transmissões, devocionais e estudos';
      await connection.query(`INSERT INTO tenant_feature_flags
        (id, organization_id, campus_id, environment, feature_key, is_enabled, category, description, updated_by)
        VALUES ('ff_g_content_analytics_v1', 'global', NULL, 'all', ?, 0, 'Conteúdo & Comunicação', ?, 'Content Analytics Migration')
        ON DUPLICATE KEY UPDATE category = VALUES(category), description = VALUES(description)`, [featureKey, description]);
      await connection.query(`INSERT INTO tenant_feature_flags
        (id, organization_id, campus_id, environment, feature_key, is_enabled, category, description, updated_by)
        VALUES ('ff_o_content_analytics_v1', 'org_default', NULL, 'production', ?, 1, 'Conteúdo & Comunicação', ?, 'Content Analytics Migration')
        ON DUPLICATE KEY UPDATE is_enabled = 1, category = VALUES(category), description = VALUES(description), updated_by = VALUES(updated_by)`, [featureKey, description]);
      await connection.query(`INSERT INTO security_audit_logs
        (id, organization_id, user_id, user_email, user_role, action, resource, resource_id, details, status)
        VALUES (UUID(), 'org_default', NULL, 'system@faithhubs.com', 'SYSTEM',
          'ENABLE_CONTENT_ANALYTICS', 'schema_migrations', ?, ?, 'SUCCESS')`,
      [migrationId, JSON.stringify({ table: 'content_engagement_events', feature_key: featureKey })]);
      await connection.query('INSERT INTO schema_migrations (migration_id, checksum) VALUES (?, ?)', [migrationId, checksum]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    console.log(JSON.stringify({ migrationId, state: 'APPLIED', featureKey }));
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");
    await connection.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
