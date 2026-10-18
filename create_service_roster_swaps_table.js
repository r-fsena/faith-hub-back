const mysql = require('mysql2/promise');
require('dotenv').config();

async function runMigration() {
  console.log('🚀 Iniciando criação da tabela `service_roster_swaps` (Shift Swap)...');

  let conn;
  try {
    conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'faith-hub'
    });

    console.log('✅ Conectado ao MySQL RDS com sucesso!');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS service_roster_swaps (
        id VARCHAR(36) PRIMARY KEY,
        organization_id VARCHAR(50) NOT NULL,
        roster_item_id VARCHAR(36) NOT NULL,
        schedule_id VARCHAR(36) NOT NULL,
        role_id VARCHAR(36) NOT NULL,
        requesting_member_id VARCHAR(36) NOT NULL,
        target_member_id VARCHAR(36) NULL,
        status ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED') DEFAULT 'PENDING',
        reason VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        responded_at TIMESTAMP NULL,
        INDEX idx_swaps_org_status (organization_id, status),
        INDEX idx_swaps_roster (roster_item_id),
        INDEX idx_swaps_target (target_member_id),
        INDEX idx_swaps_requesting (requesting_member_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log('✅ Tabela `service_roster_swaps` criada com sucesso!');
  } catch (error) {
    console.error('❌ Erro na migração:', error);
    process.exit(1);
  } finally {
    if (conn) await conn.end();
  }
}

runMigration();
