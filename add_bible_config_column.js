const mysql = require('mysql2/promise');
require('dotenv').config();

async function run() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub'
  });

  try {
    const [cols] = await connection.query(`SHOW COLUMNS FROM church_settings LIKE 'bible_config'`);
    if (cols.length === 0) {
      await connection.query(`ALTER TABLE church_settings ADD COLUMN bible_config TEXT DEFAULT NULL`);
      console.log('✔ Coluna `bible_config` adicionada na tabela `church_settings` com sucesso!');
    } else {
      console.log('ℹ Coluna `bible_config` já existe na tabela `church_settings`.');
    }
  } catch (err) {
    console.error('Erro na migration:', err);
  } finally {
    await connection.end();
  }
}

run();
