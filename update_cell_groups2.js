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
    await connection.query(`ALTER TABLE cell_groups ADD COLUMN focus VARCHAR(50) DEFAULT 'GERAL'`);
    console.log("Coluna focus adicionada!");
  } catch(e) {
    console.log("Ignorando erro:", e.message);
  }
  process.exit();
}
run();
