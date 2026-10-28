require('dotenv').config();
const crypto = require('crypto');
const { createAdminConnection } = require('./scripts/db-admin.cjs');

const migrationId = '20261028_002_secretariat_phase2';

const enabledFlags = [
  'secretariat.transfers',
  'secretariat.documents',
  'secretariat.baptisms'
];

const templates = [
  {
    id: 'tpl_org_default_presentation_letter_v1',
    type: 'PRESENTATION_LETTER',
    name: 'Carta de Apresentação',
    schema: {
      title: 'Carta de Apresentação',
      body: 'Declaramos, para os devidos fins, que {{member_name}}, registro {{registry_number}}, é membro desta comunidade de fé e encontra-se em plena comunhão.\n\nApresentamos o(a) referido(a) membro e rogamos que seja recebido(a) com amor cristão.',
      footer: '{{organization_name}} · Emitido em {{issue_date}}\n{{signatory_name}} · {{signatory_title}}',
      orientation: 'portrait'
    }
  },
  {
    id: 'tpl_org_default_transfer_letter_v1',
    type: 'TRANSFER_LETTER',
    name: 'Carta de Transferência',
    schema: {
      title: 'Carta de Transferência de Membro',
      body: 'Certificamos que {{member_name}}, registro {{registry_number}}, solicitou transferência de membresia para {{destination_church}}.\n\nA transferência foi aprovada e o histórico eclesiástico permanece arquivado nesta Secretaria.',
      footer: '{{organization_name}} · Emitido em {{issue_date}}\n{{signatory_name}} · {{signatory_title}}',
      orientation: 'portrait'
    }
  },
  {
    id: 'tpl_org_default_baptism_certificate_v1',
    type: 'BAPTISM_CERTIFICATE',
    name: 'Certificado de Batismo',
    schema: {
      title: 'Certificado de Batismo',
      body: 'Certificamos que {{member_name}} foi batizado(a) em {{baptism_date}}, conforme os princípios da fé cristã, passando a integrar formalmente esta comunidade.',
      footer: '{{organization_name}} · Emitido em {{issue_date}}\n{{signatory_name}} · {{signatory_title}}',
      orientation: 'landscape'
    }
  }
];

const checksum = crypto.createHash('sha256')
  .update(JSON.stringify({ enabledFlags, templates }))
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

    await connection.beginTransaction();
    try {
      for (const key of enabledFlags) {
        await connection.query(`INSERT INTO tenant_feature_flags
          (id, organization_id, campus_id, environment, feature_key, is_enabled, category, description, updated_by)
          VALUES (?, 'org_default', NULL, 'production', ?, 1, 'Secretaria', 'Fase 2 da Secretaria Eclesiástica', 'Secretariat Phase 2 Migration')
          ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled), category = VALUES(category),
            description = VALUES(description), updated_by = VALUES(updated_by)`,
        [`flag_org_default_${key.replace(/\./g, '_')}`, key]);
      }

      for (const template of templates) {
        await connection.query(`INSERT INTO document_templates (
            id, organization_id, campus_id, document_type, name, version, template_schema,
            is_active, created_by, updated_by
          ) VALUES (?, 'org_default', NULL, ?, ?, 1, ?, 1, 'SYSTEM', 'SYSTEM')
          ON DUPLICATE KEY UPDATE template_schema = VALUES(template_schema), is_active = 1, updated_by = 'SYSTEM'`,
        [template.id, template.type, template.name, JSON.stringify(template.schema)]);
      }

      await connection.query(`INSERT INTO security_audit_logs
        (id, organization_id, user_id, user_email, user_role, action, resource, resource_id, details, status)
        VALUES (UUID(), 'org_default', NULL, 'system@faithhubs.com', 'SYSTEM',
          'ENABLE_SECRETARIAT_PHASE2', 'schema_migrations', ?, ?, 'SUCCESS')`, [
        migrationId,
        JSON.stringify({ enabledFlags, templates: templates.map(template => template.name), publicVerification: false })
      ]);
      await connection.query('INSERT INTO schema_migrations (migration_id, checksum) VALUES (?, ?)', [migrationId, checksum]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    console.log(JSON.stringify({ migrationId, state: 'APPLIED', enabledFlags, templates: templates.length }));
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");
    await connection.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
