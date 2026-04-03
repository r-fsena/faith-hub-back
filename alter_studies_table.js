const mysql = require("mysql2/promise");
require('dotenv').config();

async function alterStudiesTable() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub',
    ssl: { rejectUnauthorized: false }
  });

  const query = `ALTER TABLE studies ADD COLUMN content_text LONGTEXT;`;

  try {
    await connection.query(query);
    console.log("Coluna content_text adicionada com sucesso!");
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') console.log("Coluna content_text já existe.");
    else console.error(err);
  }
  await connection.end();
}

alterStudiesTable().catch(console.error);
