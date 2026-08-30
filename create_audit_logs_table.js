const mysql = require('mysql2/promise');
require('dotenv').config();

async function runAuditLogMigration() {
  console.log('🚀 Criando tabela security_audit_logs para conformidade LGPD e segurança...');

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'faith-hub.cc7220s4ekvj.us-east-1.rds.amazonaws.com',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'admin_faith_hub',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub',
    ssl: { rejectUnauthorized: false }
  });

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS security_audit_logs (
        id VARCHAR(36) PRIMARY KEY,
        organization_id VARCHAR(36) NOT NULL,
        campus_id VARCHAR(36) NULL,
        user_id VARCHAR(50) NULL,
        user_email VARCHAR(150) NULL,
        user_role VARCHAR(50) NULL,
        action VARCHAR(100) NOT NULL,
        resource VARCHAR(100) NOT NULL,
        resource_id VARCHAR(100) NULL,
        details JSON NULL,
        ip_address VARCHAR(45) NULL,
        user_agent VARCHAR(255) NULL,
        status ENUM('SUCCESS', 'DENIED', 'ERROR') NOT NULL DEFAULT 'SUCCESS',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_org_action (organization_id, action),
        INDEX idx_user_date (user_email, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log('✔ Tabela `security_audit_logs` criada com sucesso!');
  } catch (err) {
    console.error('❌ Erro ao criar tabela security_audit_logs:', err);
  } finally {
    await connection.end();
  }
}

runAuditLogMigration().catch(console.error);
