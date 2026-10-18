const mysql = require('mysql2/promise');
require('dotenv').config();

async function runMigration() {
  console.log('🚀 Iniciando criação da tabela `volunteer_blockouts` (Fase 3)...');

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
      CREATE TABLE IF NOT EXISTS volunteer_blockouts (
        id VARCHAR(36) PRIMARY KEY,
        organization_id VARCHAR(50) NOT NULL,
        member_id VARCHAR(36) NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        reason VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_blockouts_org_member (organization_id, member_id),
        INDEX idx_blockouts_dates (organization_id, start_date, end_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log('✅ Tabela `volunteer_blockouts` criada com sucesso!');
  } catch (error) {
    console.error('❌ Erro na migração:', error);
    process.exit(1);
  } finally {
    if (conn) await conn.end();
  }
}

runMigration();
