const mysql = require('mysql2/promise');
require('dotenv').config();

async function createPdvTables() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub',
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('Construindo tabelas do PDV...');
    
    await connection.query(`
      CREATE TABLE IF NOT EXISTS pdv_products (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        description TEXT,
        price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        category VARCHAR(50) NOT NULL DEFAULT 'Geral',
        image_url VARCHAR(500),
        status ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    console.log('Tabela pdv_products criada com sucesso!');
  } catch (error) {
    console.error('Erro ao estruturar:', error);
  } finally {
    await connection.end();
  }
}

createPdvTables();
