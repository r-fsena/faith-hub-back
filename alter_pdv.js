const mysql = require('mysql2/promise');
require('dotenv').config();

async function alterTable() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub',
    ssl: { rejectUnauthorized: false }
  });

  try {
    await connection.query(`ALTER TABLE pdv_products CHANGE image_url image_urls TEXT`);
    console.log('image_urls alterado com sucesso');
  } catch(e) { console.error('erro 1', e); }

  try {
    await connection.query(`ALTER TABLE pdv_products MODIFY status ENUM('ACTIVE', 'INACTIVE', 'DRAFT') DEFAULT 'DRAFT'`);
    console.log('status alterado com sucesso');
  } catch(e) { console.error('erro 2', e); }

  await connection.end();
}
alterTable();
