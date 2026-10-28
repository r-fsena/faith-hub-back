require('dotenv').config();
const crypto = require('crypto');
const { createAdminConnection } = require('./scripts/db-admin.cjs');

const migrationId = '20261027_001_secretariat_foundation';

const statements = [
  `CREATE TABLE IF NOT EXISTS member_ecclesiastical_records (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL,
    campus_id VARCHAR(36) NULL,
    member_id VARCHAR(36) NOT NULL,
    registry_number VARCHAR(50) NULL,
    membership_status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    admission_type VARCHAR(30) NULL,
    admission_date DATE NULL,
    origin_church_name VARCHAR(255) NULL,
    origin_organization_id VARCHAR(36) NULL,
    baptism_date DATE NULL,
    baptism_church VARCHAR(255) NULL,
    baptism_city VARCHAR(150) NULL,
    baptism_officiant VARCHAR(255) NULL,
    notes TEXT NULL,
    created_by VARCHAR(36) NULL,
    updated_by VARCHAR(36) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_ecclesiastical_org_member (organization_id, member_id),
    UNIQUE KEY uq_ecclesiastical_registry (organization_id, registry_number),
    INDEX idx_ecclesiastical_org_campus (organization_id, campus_id),
    INDEX idx_ecclesiastical_status (organization_id, membership_status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS membership_movements (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL,
    campus_id VARCHAR(36) NULL,
    member_id VARCHAR(36) NOT NULL,
    movement_type VARCHAR(40) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
    from_organization_id VARCHAR(36) NULL,
    to_organization_id VARCHAR(36) NULL,
    from_campus_id VARCHAR(36) NULL,
    to_campus_id VARCHAR(36) NULL,
    external_church_name VARCHAR(255) NULL,
    effective_date DATE NULL,
    reason TEXT NULL,
    notes TEXT NULL,
    requested_by VARCHAR(36) NULL,
    approved_by VARCHAR(36) NULL,
    approved_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_movements_org_member (organization_id, member_id),
    INDEX idx_movements_org_status (organization_id, status),
    INDEX idx_movements_org_campus (organization_id, campus_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS secretariat_requests (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL,
    campus_id VARCHAR(36) NULL,
    member_id VARCHAR(36) NULL,
    request_type VARCHAR(50) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
    payload JSON NULL,
    requested_by VARCHAR(36) NOT NULL,
    assigned_to VARCHAR(36) NULL,
    approved_by VARCHAR(36) NULL,
    approved_at DATETIME NULL,
    completed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_secretariat_requests_org_status (organization_id, status),
    INDEX idx_secretariat_requests_org_member (organization_id, member_id),
    INDEX idx_secretariat_requests_org_campus (organization_id, campus_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS baptism_records (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL,
    campus_id VARCHAR(36) NULL,
    member_id VARCHAR(36) NOT NULL,
    baptism_date DATE NOT NULL,
    baptism_church VARCHAR(255) NULL,
    baptism_location VARCHAR(255) NULL,
    baptism_city VARCHAR(150) NULL,
    officiant_name VARCHAR(255) NULL,
    ceremony_name VARCHAR(255) NULL,
    notes TEXT NULL,
    created_by VARCHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_baptisms_org_member (organization_id, member_id),
    INDEX idx_baptisms_org_date (organization_id, baptism_date),
    INDEX idx_baptisms_org_campus (organization_id, campus_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS document_templates (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL,
    campus_id VARCHAR(36) NULL,
    document_type VARCHAR(50) NOT NULL,
    name VARCHAR(150) NOT NULL,
    version INT NOT NULL DEFAULT 1,
    template_schema JSON NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by VARCHAR(36) NOT NULL,
    updated_by VARCHAR(36) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_document_template_version (organization_id, document_type, name, version),
    INDEX idx_document_templates_org_active (organization_id, is_active),
    INDEX idx_document_templates_org_campus (organization_id, campus_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS document_signatories (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL,
    campus_id VARCHAR(36) NULL,
    member_id VARCHAR(36) NULL,
    name VARCHAR(255) NOT NULL,
    title VARCHAR(150) NOT NULL,
    signature_object_key VARCHAR(500) NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by VARCHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_signatories_org_active (organization_id, is_active),
    INDEX idx_signatories_org_campus (organization_id, campus_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS issued_documents (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL,
    campus_id VARCHAR(36) NULL,
    member_id VARCHAR(36) NULL,
    request_id VARCHAR(36) NULL,
    template_id VARCHAR(36) NULL,
    document_type VARCHAR(50) NOT NULL,
    document_number VARCHAR(80) NOT NULL,
    template_version INT NOT NULL,
    template_snapshot JSON NOT NULL,
    file_object_key VARCHAR(500) NULL,
    file_checksum CHAR(64) NULL,
    verification_token_hash CHAR(64) NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'VALID',
    issued_by VARCHAR(36) NOT NULL,
    approved_by VARCHAR(36) NULL,
    issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_by VARCHAR(36) NULL,
    revoked_at DATETIME NULL,
    revocation_reason TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_issued_document_number (organization_id, document_number),
    UNIQUE KEY uq_issued_verification_hash (verification_token_hash),
    INDEX idx_issued_documents_org_member (organization_id, member_id),
    INDEX idx_issued_documents_org_status (organization_id, status),
    INDEX idx_issued_documents_org_campus (organization_id, campus_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

const featureFlags = [
  ['secretariat.module_enabled', 'Habilita o módulo de Secretaria Eclesiástica'],
  ['secretariat.member_registry', 'Habilita prontuários e dados eclesiásticos dos membros'],
  ['secretariat.transfers', 'Habilita movimentações e transferências de membros'],
  ['secretariat.documents', 'Habilita cartas, declarações e documentos eclesiásticos'],
  ['secretariat.baptisms', 'Habilita gestão de batismos e certificados'],
  ['secretariat.public_verification', 'Habilita validação pública de documentos por QR Code']
];

const checksum = crypto.createHash('sha256')
  .update(JSON.stringify({ statements, featureFlags }))
  .digest('hex');

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

    for (const statement of statements) await connection.query(statement);

    await connection.beginTransaction();
    try {
      for (const [key, description] of featureFlags) {
        const id = `flag_global_${key.replace(/\./g, '_')}`;
        await connection.query(`INSERT INTO tenant_feature_flags
          (id, organization_id, campus_id, environment, feature_key, is_enabled, category, description, updated_by)
          VALUES (?, 'global', NULL, 'all', ?, 0, 'Secretaria', ?, 'Secretariat Migration')
          ON DUPLICATE KEY UPDATE category = VALUES(category), description = VALUES(description)`,
        [id, key, description]);
      }

      for (const key of ['secretariat.module_enabled', 'secretariat.member_registry']) {
        const id = `flag_org_default_${key.replace(/\./g, '_')}`;
        await connection.query(`INSERT INTO tenant_feature_flags
          (id, organization_id, campus_id, environment, feature_key, is_enabled, category, description, updated_by)
          VALUES (?, 'org_default', NULL, 'production', ?, 1, 'Secretaria', 'Piloto da primeira fase da Secretaria', 'Secretariat Migration')
          ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled), category = VALUES(category), description = VALUES(description)`,
        [id, key]);
      }

      await connection.query(`INSERT INTO security_audit_logs
        (id, organization_id, user_id, user_email, user_role, action, resource, resource_id, details, status)
        VALUES (UUID(), 'org_default', NULL, 'system@faithhubs.com', 'SYSTEM',
          'CREATE_SECRETARIAT_FOUNDATION', 'schema_migrations', ?, ?, 'SUCCESS')`, [
        migrationId,
        JSON.stringify({ tables: statements.length, featureFlags: featureFlags.map(([key]) => key), pilot: 'org_default' })
      ]);

      await connection.query('INSERT INTO schema_migrations (migration_id, checksum) VALUES (?, ?)', [migrationId, checksum]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }

    console.log(JSON.stringify({ migrationId, state: 'APPLIED', tables: statements.length }));
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");
    await connection.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
