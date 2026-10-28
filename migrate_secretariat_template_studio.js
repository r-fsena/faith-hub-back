require('dotenv').config();
const crypto = require('crypto');
const { createAdminConnection } = require('./scripts/db-admin.cjs');

const migrationId = '20261028_004_secretariat_template_studio';
const columns = [
  ['template_key', "VARCHAR(36) NULL AFTER id"],
  ['status', "VARCHAR(30) NOT NULL DEFAULT 'PUBLISHED' AFTER template_schema"],
  ['base_template_id', "VARCHAR(36) NULL AFTER status"],
  ['submitted_by', "VARCHAR(36) NULL AFTER updated_by"],
  ['submitted_at', "DATETIME NULL AFTER submitted_by"],
  ['approved_by', "VARCHAR(36) NULL AFTER submitted_at"],
  ['approved_at', "DATETIME NULL AFTER approved_by"],
  ['published_by', "VARCHAR(36) NULL AFTER approved_at"],
  ['published_at', "DATETIME NULL AFTER published_by"],
  ['archived_by', "VARCHAR(36) NULL AFTER published_at"],
  ['archived_at', "DATETIME NULL AFTER archived_by"]
];
const indexes = [
  ['idx_document_templates_org_key', '(organization_id, template_key, version)'],
  ['idx_document_templates_org_status', '(organization_id, status, campus_id)']
];
const flags = [
  ['secretariat.template_editor', 'Editor, versionamento e aprovação dos modelos da Secretaria'],
  ['secretariat.document_pdf', 'Geração e download de documentos oficiais em PDF'],
  ['secretariat.public_verification', 'Validação pública de documentos por QR Code']
];
const checksum = crypto.createHash('sha256').update(JSON.stringify({ columns, indexes, flags })).digest('hex');

async function columnExists(connection, column) {
  const [rows] = await connection.query(`SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'document_templates' AND COLUMN_NAME = ? LIMIT 1`, [column]);
  return rows.length > 0;
}

async function indexExists(connection, index) {
  const [rows] = await connection.query(`SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'document_templates' AND INDEX_NAME = ? LIMIT 1`, [index]);
  return rows.length > 0;
}

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

    for (const [name, definition] of columns) {
      if (!(await columnExists(connection, name))) {
        await connection.query(`ALTER TABLE document_templates ADD COLUMN ${name} ${definition}`);
      }
    }
    for (const [name, definition] of indexes) {
      if (!(await indexExists(connection, name))) {
        await connection.query(`ALTER TABLE document_templates ADD INDEX ${name} ${definition}`);
      }
    }

    await connection.beginTransaction();
    try {
      await connection.query(`UPDATE document_templates SET
        template_key = COALESCE(template_key, id),
        status = CASE WHEN is_active = 1 THEN 'PUBLISHED' ELSE 'ARCHIVED' END,
        published_at = COALESCE(published_at, created_at),
        published_by = COALESCE(published_by, updated_by, created_by)
        WHERE template_key IS NULL OR status IS NULL OR published_at IS NULL`);

      for (const [key, description] of flags) {
        await connection.query(`INSERT INTO tenant_feature_flags
          (id, organization_id, campus_id, environment, feature_key, is_enabled, category, description, updated_by)
          VALUES (?, 'global', NULL, 'all', ?, 0, 'Secretaria', ?, 'Secretariat Template Studio Migration')
          ON DUPLICATE KEY UPDATE category = VALUES(category), description = VALUES(description)`,
        [`flag_global_${key.replace(/\./g, '_')}`, key, description]);
        await connection.query(`INSERT INTO tenant_feature_flags
          (id, organization_id, campus_id, environment, feature_key, is_enabled, category, description, updated_by)
          VALUES (?, 'org_default', NULL, 'production', ?, 1, 'Secretaria', ?, 'Secretariat Template Studio Migration')
          ON DUPLICATE KEY UPDATE is_enabled = 1, category = VALUES(category), description = VALUES(description), updated_by = VALUES(updated_by)`,
        [`flag_org_default_${key.replace(/\./g, '_')}`, key, description]);
      }
      await connection.query(`INSERT INTO security_audit_logs
        (id, organization_id, user_id, user_email, user_role, action, resource, resource_id, details, status)
        VALUES (UUID(), 'org_default', NULL, 'system@faithhubs.com', 'SYSTEM',
          'ENABLE_SECRETARIAT_TEMPLATE_STUDIO', 'schema_migrations', ?, ?, 'SUCCESS')`,
      [migrationId, JSON.stringify({ flags: flags.map(([key]) => key), versioning: true, publicVerification: true })]);
      await connection.query('INSERT INTO schema_migrations (migration_id, checksum) VALUES (?, ?)', [migrationId, checksum]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    console.log(JSON.stringify({ migrationId, state: 'APPLIED', columns: columns.length, flags: flags.length }));
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");
    await connection.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
