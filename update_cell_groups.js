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
    await connection.query(`ALTER TABLE cell_groups 
      ADD COLUMN description TEXT,
      ADD COLUMN address VARCHAR(500),
      ADD COLUMN neighborhood VARCHAR(100),
      ADD COLUMN meeting_day VARCHAR(50),
      ADD COLUMN meeting_time VARCHAR(20),
      ADD COLUMN whatsapp_contact VARCHAR(20),
      ADD COLUMN status VARCHAR(50) DEFAULT 'ACTIVE'`);
    console.log("Colunas adicionadas com sucesso!");
  } catch(e) {
    if (e.code === 'ER_DUP_FIELDNAME') console.log("Colunas já existem!");
    else console.error("Erro:", e);
  }
  process.exit();
}
run();
