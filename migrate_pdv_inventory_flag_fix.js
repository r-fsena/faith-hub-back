require('dotenv').config();
const crypto = require('crypto');
const { createAdminConnection } = require('./scripts/db-admin.cjs');

const migrationId = '20261028_010_pdv_inventory_flag_stabilization';
const description = 'Estoque por unidade, movimentações, reservas e baixa automática de vendas';
const insertedFlagId = 'flag_global_pdv_stock_inventory_v2';
const checksum = crypto.createHash('sha256').update(JSON.stringify({ feature: 'pdv.stock_inventory', description, insertedFlagId, strategy: 'restore-existing-or-enable-created' })).digest('hex');

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
    await connection.beginTransaction();
    try {
      const [existing] = await connection.query(
        `SELECT id FROM tenant_feature_flags
          WHERE organization_id = 'global' AND campus_id IS NULL AND environment = 'all'
            AND feature_key = 'pdv.stock_inventory' AND id <> ? FOR UPDATE`,
        [insertedFlagId]
      );
      let action;
      let affectedRows;
      if (existing.length) {
        // Restaura exatamente o estado anterior à migração 009, removendo somente a linha que ela criou.
        const [result] = await connection.query('DELETE FROM tenant_feature_flags WHERE id = ?', [insertedFlagId]);
        action = 'REMOVED_MIGRATION_DUPLICATE';
        affectedRows = result.affectedRows || 0;
      } else {
        // Instalação nova: a própria linha da migração 009 vira o default global ativo do catálogo.
        const [result] = await connection.query(
          `UPDATE tenant_feature_flags
              SET is_enabled = 1, category = 'PDV', description = ?, updated_by = 'PDV Inventory Stabilization', updated_at = NOW()
            WHERE id = ?`,
          [description, insertedFlagId]
        );
        action = 'ENABLED_NEW_DEFAULT';
        affectedRows = result.affectedRows || 0;
      }
      await connection.query(`INSERT INTO security_audit_logs
        (id, organization_id, user_id, user_email, user_role, action, resource, resource_id, details, status)
        VALUES (UUID(), 'org_default', NULL, 'system@faithhubs.com', 'SYSTEM',
          'STABILIZE_PDV_INVENTORY_FEATURE_FLAG', 'schema_migrations', ?, ?, 'SUCCESS')`,
      [migrationId, JSON.stringify({ affectedRows, action, feature: 'pdv.stock_inventory' })]);
      await connection.query('INSERT INTO schema_migrations (migration_id, checksum) VALUES (?, ?)', [migrationId, checksum]);
      await connection.commit();
      console.log(JSON.stringify({ migrationId, state: 'APPLIED', affectedRows, action }));
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
