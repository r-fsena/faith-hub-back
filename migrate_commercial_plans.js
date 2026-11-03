require('dotenv').config();
const crypto = require('crypto');
const catalog = require('./src/config/commercialPlans.json');
const { createAdminConnection } = require('./scripts/db-admin.cjs');

const migrationId = '20261102_001_commercial_plans';
const checksum = crypto.createHash('sha256').update(JSON.stringify(catalog)).digest('hex');

async function main() {
  // Local validation never connects to a database.
  if (process.argv.includes('--check')) {
    for (const plan of catalog.plans) {
      if (plan.requires_proposal && (plan.monthly_price !== null || plan.max_members !== null || plan.max_campuses !== null)) throw new Error('INVALID_ENTERPRISE_DEFAULTS');
      if (plan.yearly_price !== null) throw new Error('ANNUAL_PRICE_NOT_DEFINED');
    }
    console.log(JSON.stringify({ migrationId, state: 'CATALOG_VALID', plans: catalog.plans.map(plan => plan.id) }));
    return;
  }
  const connection = await createAdminConnection();
  let locked = false;
  try {
    const [locks] = await connection.query("SELECT GET_LOCK('faith_hub_schema_migrations', 30) AS acquired");
    locked = Number(locks[0].acquired) === 1;
    if (!locked) throw new Error('MIGRATION_LOCK_TIMEOUT');
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id VARCHAR(150) PRIMARY KEY, checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const [applied] = await connection.query('SELECT checksum FROM schema_migrations WHERE migration_id = ?', [migrationId]);
    if (process.argv.includes('--status')) {
      console.log(JSON.stringify({ migrationId, state: applied.length ? 'APPLIED' : 'PENDING', checksumMatches: !applied.length || applied[0].checksum === checksum }));
      return;
    }
    if (applied.length) {
      if (applied[0].checksum !== checksum) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
      console.log(JSON.stringify({ migrationId, state: 'ALREADY_APPLIED' }));
      return;
    }
    await connection.query(`CREATE TABLE IF NOT EXISTS saas_plans (
      id VARCHAR(50) PRIMARY KEY, name VARCHAR(150) NOT NULL, description TEXT,
      monthly_price DECIMAL(10,2) NULL, yearly_price DECIMAL(10,2) NULL,
      badge_text VARCHAR(100), is_popular BOOLEAN DEFAULT FALSE,
      max_members INT NULL, max_campuses INT NULL, features JSON,
      status VARCHAR(30) DEFAULT 'ACTIVE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    for (const [table, column, definition] of [
      ['saas_plans', 'entitlements', 'JSON NULL'],
      ['saas_plans', 'requires_proposal', 'BOOLEAN NOT NULL DEFAULT FALSE'],
      ['saas_plans', 'catalog_version', 'VARCHAR(30) NULL'],
      ['saas_proposals', 'plan_contract', 'JSON NULL'],
      ['organizations', 'plan_contract', 'JSON NULL']
    ]) {
      const [columns] = await connection.query('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, column]);
      if (!columns.length) await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    }
    // Null means “defined by proposal”, without changing the values of any existing record.
    for (const column of ['monthly_price', 'yearly_price']) await connection.query(`ALTER TABLE saas_plans MODIFY \`${column}\` DECIMAL(10,2) NULL`);
    for (const column of ['max_members', 'max_campuses']) await connection.query(`ALTER TABLE saas_plans MODIFY \`${column}\` INT NULL`);
    for (const [table, column] of [['organizations', 'plan'], ['saas_proposals', 'plan_tier']]) {
      const [columns] = await connection.query('SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, column]);
      if (columns[0]?.DATA_TYPE === 'enum') await connection.query(`ALTER TABLE \`${table}\` MODIFY \`${column}\` VARCHAR(50)`);
    }
    if (process.argv.includes('--schema-only')) {
      console.log(JSON.stringify({ migrationId, state: 'SCHEMA_READY', plansPublished: false, existingContractsChanged: false }));
      return;
    }
    await connection.beginTransaction();
    try {
      for (const plan of catalog.plans) {
        // Reserved versioned Enterprise ID preserves the old ENTERPRISE catalog and its contracts.
        const [existing] = await connection.query('SELECT id, catalog_version FROM saas_plans WHERE id = ? FOR UPDATE', [plan.id]);
        if (existing.length) throw new Error(`PLAN_ID_ALREADY_EXISTS:${plan.id}`);
        await connection.query(`INSERT INTO saas_plans
          (id, name, description, monthly_price, yearly_price, badge_text, is_popular,
           max_members, max_campuses, features, status, entitlements, requires_proposal, catalog_version)
          VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`, [
          plan.id, plan.name, plan.description, plan.monthly_price, plan.badge_text, plan.is_popular,
          plan.max_members, plan.max_campuses, JSON.stringify(plan.features), JSON.stringify(plan.entitlements), plan.requires_proposal, catalog.version
        ]);
      }
      for (const key of ['visitors.module_enabled', 'pastoral.module_enabled', 'ministries.module_enabled', 'volunteers.module_enabled', 'system.plan_entitlements']) {
        const id = crypto.createHash('sha256').update(`global:${key}:2026`).digest('hex').slice(0,36);
        await connection.query(`INSERT INTO tenant_feature_flags
          (id, organization_id, campus_id, environment, feature_key, is_enabled, category, description, updated_by)
          SELECT ?, 'global', NULL, 'all', ?, ?, 'Planos comerciais', ?, 'Commercial Plans Migration'
          WHERE NOT EXISTS (SELECT 1 FROM tenant_feature_flags WHERE organization_id = 'global' AND campus_id IS NULL AND environment = 'all' AND feature_key = ?)`,
        [id, key, key === 'system.plan_entitlements' ? 0 : 1, key, key]);
      }
      await connection.query(`INSERT INTO security_audit_logs
        (id, organization_id, user_email, user_role, action, resource, resource_id, details, status)
        VALUES (UUID(), 'org_default', 'system@faithhubs.com', 'SYSTEM', 'CREATE_COMMERCIAL_PLAN_CATALOG', 'schema_migrations', ?, ?, 'SUCCESS')`,
      [migrationId, JSON.stringify({ checksum, plans: catalog.plans.map(plan => plan.id), existingContractsChanged: false })]);
      await connection.query('INSERT INTO schema_migrations (migration_id, checksum) VALUES (?, ?)', [migrationId, checksum]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    console.log(JSON.stringify({ migrationId, state: 'APPLIED', existingContractsChanged: false }));
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");
    await connection.end();
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, migrationId };
