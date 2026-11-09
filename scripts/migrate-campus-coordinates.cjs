/** Additive, idempotent migration. Does not infer coordinates from addresses. */
require('dotenv').config({ quiet: true });
const { createAdminConnection } = require('./db-admin.cjs');
async function migrate(db) {
  const [columns] = await db.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campuses'");
  for (const [name, type] of [['latitude', 'DECIMAL(10,7)'], ['longitude', 'DECIMAL(11,7)']]) {
    if (!columns.some(c => c.COLUMN_NAME === name)) await db.query(`ALTER TABLE campuses ADD COLUMN ${name} ${type} NULL`);
  }
}
module.exports = { migrate };
if (require.main === module) (async () => { const db = await createAdminConnection(); try { await migrate(db); console.log('CAMPUS_COORDINATES_SCHEMA_READY'); } finally { await db.end(); } })().catch(e => { console.error(e.code || e.name); process.exitCode = 1; });
