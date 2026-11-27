const fs = require('node:fs');
const crypto = require('node:crypto');

const migrationId = '20261127_001_cell_group_offerings';
const flagId = 'ff_cell_group_offerings_default';
const featureKey = 'cell_groups.offerings';
const checksum = () => crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');

// Importing this module never opens connections or loads credentials.
async function applyMigration(db, { statusOnly = false } = {}) {
  const sum = checksum();
  const [prior] = await db.query('SELECT checksum FROM schema_migrations WHERE migration_id = ?', [migrationId]);
  if (statusOnly) return { migrationId, applied: !!prior.length, checksumMatches: !prior.length || prior[0].checksum === sum };
  let locked = false;
  try {
    const [lock] = await db.query("SELECT GET_LOCK('faith_hub_schema_migrations',30) AS acquired");
    locked = Number(lock[0].acquired) === 1;
    if (!locked) throw Error('MIGRATION_LOCK_TIMEOUT');
    const [current] = await db.query('SELECT checksum FROM schema_migrations WHERE migration_id = ?', [migrationId]);
    if (current.length) {
      if (current[0].checksum !== sum) throw Error('MIGRATION_CHECKSUM_MISMATCH');
      return { migrationId, applied: true, alreadyApplied: true };
    }
    await db.beginTransaction();
    try {
      const [existing] = await db.query(
        "SELECT id FROM tenant_feature_flags WHERE organization_id = ? AND campus_id IS NULL AND environment = 'all' AND feature_key = ? FOR UPDATE",
        ['global', featureKey]
      );
      if (!existing.length) await db.query(
        `INSERT INTO tenant_feature_flags(id,organization_id,campus_id,environment,feature_key,is_enabled,category,description,updated_by)
         VALUES(?,?,NULL,'all',?,0,'Pequenos grupos',?,'cell-group-offerings-migration')`,
        [flagId, 'global', featureKey, 'Registro de ofertas nas reuniões dos pequenos grupos']
      );
      await db.query(
        `INSERT INTO security_audit_logs(id,organization_id,user_role,action,resource,resource_id,details,status)
         VALUES(UUID(),?,'SYSTEM','REGISTER_CELL_GROUP_OFFERINGS_FLAG','tenant_feature_flags',?,?,'SUCCESS')`,
        ['global', featureKey, JSON.stringify({ migrationId, inserted: !existing.length, defaultEnabled: false, existingOverridesPreserved: true })]
      );
      await db.query('INSERT INTO schema_migrations(migration_id,checksum) VALUES(?,?)', [migrationId, sum]);
      await db.commit();
      return { migrationId, applied: true, inserted: !existing.length, flagsEnabled: 0 };
    } catch (error) {
      await db.rollback();
      throw error;
    }
  } finally {
    if (locked) await db.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");
  }
}

module.exports = { migrationId, flagId, featureKey, applyMigration };
if (require.main === module) {
  if (!process.argv.includes('--status') && !process.argv.includes('--apply')) throw Error('Use --status ou --apply; publicação e migração exigem autorização específica.');
  require('dotenv').config({ quiet: true });
  (async () => {
    const db = await require('./scripts/db-admin.cjs').createAdminConnection();
    try { console.log(JSON.stringify(await applyMigration(db, { statusOnly: process.argv.includes('--status') }))); }
    finally { await db.end(); }
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
