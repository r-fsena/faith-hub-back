const mysql = require('mysql2/promise');
require('dotenv').config();

async function migrate() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub',
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('Adicionando status aos devocionais...');
    // Add status column
    await connection.query(`
      ALTER TABLE devotionals 
      ADD COLUMN status ENUM('DRAFT', 'PUBLISHED') DEFAULT 'DRAFT' AFTER title;
    `);
    
    // Update existing records to PUBLISHED 
    await connection.query(`
      UPDATE devotionals SET status = 'PUBLISHED' WHERE status = 'DRAFT';
    `);

    console.log('Migração concluída com sucesso!');
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') {
      console.log('Coluna status já existe.');
    } else {
      console.error(err);
    }
  } finally {
    connection.end();
  }
}

migrate();
