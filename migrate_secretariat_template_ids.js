require('dotenv').config();
const crypto = require('crypto');
const { createAdminConnection } = require('./scripts/db-admin.cjs');

const migrationId = '20261028_003_secretariat_template_ids';
const mappings = [
  ['tpl_org_default_presentation_letter_', 'tpl_secretariat_presentation_v1'],
  ['tpl_org_default_transfer_letter_v1', 'tpl_secretariat_transfer_v1'],
  ['tpl_org_default_baptism_certificate_', 'tpl_secretariat_baptism_v1']
];
const checksum = crypto.createHash('sha256').update(JSON.stringify(mappings)).digest('hex');

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

    await connection.beginTransaction();
    try {
      for (const [oldId, newId] of mappings) {
        const [source] = await connection.query(
          `SELECT id FROM document_templates WHERE organization_id = 'org_default' AND id = ? FOR UPDATE`,
          [oldId]
        );
        if (!source.length) throw new Error(`TEMPLATE_ID_SOURCE_NOT_FOUND:${oldId}`);
        const [target] = await connection.query(
          `SELECT id FROM document_templates WHERE organization_id = 'org_default' AND id = ? FOR UPDATE`,
          [newId]
        );
        if (target.length) throw new Error(`TEMPLATE_ID_ALREADY_EXISTS:${newId}`);
        await connection.query(`UPDATE issued_documents SET template_id = ?
          WHERE organization_id = 'org_default' AND template_id = ?`, [newId, oldId]);
        await connection.query(`UPDATE document_templates SET id = ?, updated_by = 'Secretariat Template ID Repair'
          WHERE organization_id = 'org_default' AND id = ?`, [newId, oldId]);
      }
      await connection.query(`INSERT INTO security_audit_logs
        (id, organization_id, user_id, user_email, user_role, action, resource, resource_id, details, status)
        VALUES (UUID(), 'org_default', NULL, 'system@faithhubs.com', 'SYSTEM',
          'REPAIR_SECRETARIAT_TEMPLATE_IDS', 'document_templates', ?, ?, 'SUCCESS')`, [
        migrationId, JSON.stringify({ mappings })
      ]);
      await connection.query('INSERT INTO schema_migrations (migration_id, checksum) VALUES (?, ?)', [migrationId, checksum]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    console.log(JSON.stringify({ migrationId, state: 'APPLIED', repaired: mappings.length }));
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");
    await connection.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
