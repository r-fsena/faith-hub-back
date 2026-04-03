const mysql = require('mysql2/promise');
require('dotenv').config();

async function run() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub',
    ssl: { rejectUnauthorized: false }
  });

  try {
    await connection.query(`ALTER TABLE members ADD COLUMN pending_cell_group_id VARCHAR(36) NULL;`);
    console.log("Coluna pending_cell_group_id adicionada na tabela members!");
  } catch(e) {
    console.log("Ignorando erro:", e.message);
  }
  process.exit();
}
run();
