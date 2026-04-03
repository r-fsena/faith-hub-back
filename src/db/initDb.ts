import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';

// Script responsável por inicializar o Banco e as tabelas
async function runSchema() {
  try {
    console.log("🛠️  Conectando ao servidor MySQL na AWS para verificar o banco de dados...");
    
    // Conecta sem especificar "database" para podermos criá-lo se não existir
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: { rejectUnauthorized: false }
    });

    const dbName = process.env.DB_NAME || 'faith-hub';
    console.log(`🔍 Verificando banco de dados: '${dbName}'...`);
    
    // Cria o banco se o usuário não tiver preenchido a opção "Initial Database Name" lá na amazon
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`);
    await connection.query(`USE \`${dbName}\`;`);
    
    console.log("✅  Banco de dados conferido. Preparando tabelas...");

    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    // Como o schema.sql pode ter mais de um comando, precisamos separar pelo ponto-e-vírgula
    const queries = sql.split(';').filter(q => q.trim() !== '');

    for (let q of queries) {
      await connection.query(q);
    }

    console.log("✅  Tabelas 'members' e 'cell_groups' provisionadas com sucesso!");
    
    await connection.end();
    process.exit(0);

  } catch (error) {
    console.error("❌ Erro ao criar as tabelas:", error);
    process.exit(1);
  }
}

runSchema();
