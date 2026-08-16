const mysql = require('mysql2/promise');
require('dotenv').config();

async function initDatabase() {
  console.log('--- INICIALIZANDO BANCO NO RDS ---');
  try {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD
    });

    console.log('✅ Conectado ao servidor MySQL com sucesso!');

    const [dbs] = await conn.query('SHOW DATABASES;');
    console.log('Bancos de dados existentes no servidor:', dbs.map(d => d.Database));

    console.log('Criando banco `faith-hub`...');
    await conn.query('CREATE DATABASE IF NOT EXISTS `faith-hub` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;');
    console.log('✅ Banco de dados `faith-hub` pronto!');

    await conn.end();
  } catch (err) {
    console.error('❌ Erro:', err.message);
  }
}

initDatabase();
