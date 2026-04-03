const mysql = require('mysql2/promise');
require('dotenv').config();

async function createPdvOrdersTable() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub',
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('Construindo tabela de pdv_orders...');
    
    await connection.query(`
      CREATE TABLE IF NOT EXISTS pdv_orders (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL,
        user_name VARCHAR(150) NOT NULL,
        status ENUM('RECEBIDO', 'PREPARANDO', 'PRONTO', 'ENTREGUE', 'CANCELADO') DEFAULT 'RECEBIDO',
        delivery_method ENUM('church', 'home') NOT NULL,
        delivery_details TEXT NOT NULL,
        items_json JSON NOT NULL,
        total_price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    console.log('Tabela pdv_orders estruturada com sucesso no RDS!');
  } catch (error) {
    console.error('Erro estrutural:', error);
  } finally {
    await connection.end();
  }
}

createPdvOrdersTable();
