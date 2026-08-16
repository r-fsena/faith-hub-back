const mysql = require('mysql2/promise');
require('dotenv').config();

async function testModes() {
  console.log('--- TESTANDO CONEXÃO COM MYSQL RDS ---');
  
  // Tentativa 1: Sem SSL forçado
  try {
    console.log('\n[1] Tentando sem SSL forçado...');
    const conn1 = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: 'faith-hub'
    });
    console.log('✅ Conectado com sucesso sem SSL!');
    const [tables] = await conn1.query('SHOW TABLES;');
    console.log('Tabelas existentes:', tables.map(r => Object.values(r)[0]));
    await conn1.end();
    return;
  } catch (err) {
    console.log('Tentativa 1 falhou:', err.message);
  }

  // Tentativa 2: Com SSL 'Amazon RDS'
  try {
    console.log('\n[2] Tentando com SSL Amazon RDS...');
    const conn2 = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: 'faith-hub',
      ssl: 'Amazon RDS'
    });
    console.log('✅ Conectado com sucesso com SSL Amazon RDS!');
    const [tables] = await conn2.query('SHOW TABLES;');
    console.log('Tabelas existentes:', tables.map(r => Object.values(r)[0]));
    await conn2.end();
    return;
  } catch (err) {
    console.log('Tentativa 2 falhou:', err.message);
  }
}

testModes();
