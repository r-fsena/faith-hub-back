// Run explicitly before deploying the tenant-scoped gateway endpoints.
// Legacy configurations remain unassigned: never copy credentials across churches.
require('dotenv').config();
const mysql = require('mysql2/promise');

async function migrate() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'require' ? { rejectUnauthorized: true } : undefined
  });
  try {
    const [columns] = await db.query("SHOW COLUMNS FROM payment_gateway_settings LIKE 'organization_id'");
    if (!columns.length) await db.query('ALTER TABLE payment_gateway_settings ADD COLUMN organization_id VARCHAR(100) NULL');
    const [payloadColumn] = await db.query("SHOW COLUMNS FROM payment_gateway_settings LIKE 'config_payload'");
    if (!payloadColumn.length) await db.query('ALTER TABLE payment_gateway_settings ADD COLUMN config_payload JSON NULL');
    const [indexes] = await db.query("SHOW INDEX FROM payment_gateway_settings WHERE Key_name = 'uq_gateway_organization'");
    if (!indexes.length) await db.query('ALTER TABLE payment_gateway_settings ADD UNIQUE KEY uq_gateway_organization (organization_id)');
    for (const flag of [
      ['members.digital_card', 'Membros', 'Carteirinha digital do membro'],
      ['financial.advanced_reports', 'Finanças', 'Mix de pagamentos e ranking por campus']
    ]) {
      await db.query(`INSERT INTO tenant_feature_flags (id, organization_id, campus_id, environment, feature_key, is_enabled, category, description)
        SELECT UUID(), 'global', NULL, 'all', ?, 1, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM tenant_feature_flags WHERE organization_id = 'global' AND campus_id IS NULL AND environment = 'all' AND feature_key = ?)`,
        [flag[0], flag[1], flag[2], flag[0]]);
    }
    console.log('Migração concluída. Configurações legadas sem organização permanecem inacessíveis até atribuição revisada.');
  } finally { await db.end(); }
}
migrate().catch(error => { console.error(error.message); process.exitCode = 1; });
