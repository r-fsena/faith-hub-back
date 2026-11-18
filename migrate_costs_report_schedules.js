const fs = require('node:fs');
const crypto = require('node:crypto');
const schema = require('./scripts/cost-schedules-schema.cjs');

const migrationId = '20261117_002_costs_report_schedules';
const checksum = () => crypto.createHash('sha256')
  .update(fs.readFileSync(__filename))
  .update(fs.readFileSync(require.resolve('./scripts/cost-schedules-schema.cjs')))
  .digest('hex');

// Importing this module never loads .env, credentials or database connections.
async function applyMigration(db, { statusOnly = false } = {}) {
  const sum = checksum();
  const [prior] = await db.query('SELECT checksum FROM schema_migrations WHERE migration_id = ?', [migrationId]);
  if (statusOnly) return { migrationId, applied: !!prior.length, checksumMatches: !prior.length || prior[0].checksum === sum, flagsChanged: false };
  let locked = false;
  try {
    const [lock] = await db.query("SELECT GET_LOCK('faith_hub_schema_migrations',30) AS acquired");
    locked = Number(lock[0].acquired) === 1;
    if (!locked) throw Error('MIGRATION_LOCK_TIMEOUT');
    const [current] = await db.query('SELECT checksum FROM schema_migrations WHERE migration_id = ?', [migrationId]);
    if (current.length) {
      if (current[0].checksum !== sum) throw Error('MIGRATION_CHECKSUM_MISMATCH');
      return { migrationId, applied: true, alreadyApplied: true, flagsChanged: false };
    }
    const [base] = await db.query('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', ['20261113_003_intelligence_evolution']);
    const required = ['pdv_inventory_balances', 'pdv_inventory_reservations', 'pdv_inventory_movements', 'pdv_order_items', 'intelligence_reports'];
    const [tables] = await db.query(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN (${required.map(() => '?').join(',')})`, required);
    if (!base.length || required.some(name => !tables.some(t => t.name === name))) throw Error('REPORTS_AND_INVENTORY_FOUNDATION_REQUIRED');
    await schema.applySchema(db);
    await db.beginTransaction();
    try {
      for (const key of ['pdv.historical_costs', 'intelligence.report_schedules']) {
        await db.query("INSERT IGNORE INTO tenant_feature_flags(id,organization_id,environment,feature_key,is_enabled,category,description,updated_by) VALUES(?,'global','all',?,0,'Inteligência',?,'cost-schedules-migration')", [
          'ff_f4r2_' + crypto.createHash('sha256').update(key).digest('hex').slice(0,24), key, key
        ]);
      }
      await db.query("INSERT INTO security_audit_logs(id,organization_id,user_role,action,resource,resource_id,details,status) VALUES(UUID(),'global','SYSTEM','COST_SCHEDULES_MIGRATION','schema_migrations',?,?,'SUCCESS')", [migrationId, JSON.stringify({ flagsEnabledByMigration: 0, historyInvented: false })]);
      await db.query('INSERT INTO schema_migrations(migration_id,checksum) VALUES(?,?)', [migrationId, sum]);
      await db.commit();
    } catch (error) {
      await db.rollback();
      throw error;
    }
    return { migrationId, applied: true, flagsEnabledByMigration: 0, historyInvented: false };
  } finally {
    if (locked) await db.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");
  }
}

module.exports = { migrationId, applySchema: schema.applySchema, applyMigration };
if (require.main === module) {
  if (!process.argv.includes('--status') && !process.argv.includes('--apply')) throw Error('USE --status ou --apply; autorização de produção obrigatória.');
  require('dotenv').config({ quiet: true });
  (async () => {
    const db = await require('./scripts/db-admin.cjs').createAdminConnection();
    try { console.log(JSON.stringify(await applyMigration(db, { statusOnly: process.argv.includes('--status') }))); }
    finally { await db.end(); }
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
