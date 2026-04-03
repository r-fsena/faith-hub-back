import { query } from './index';

async function testConnection() {
  try {
    console.log("🛠️  Fazendo o DESCRIBE das suas tabelas direto pelo NodeJS...");
    
    const dbName = process.env.DB_NAME || 'faith-hub';
    
    // Mostrando as tabelas existentes
    const tables = await query("SHOW TABLES;");
    console.log("\n📁 Tabelas DENTRO do banco:", tables.rows.map((r: any) => Object.values(r)[0]));

    // Dando "DESCRIBE" na members
    const dMembers = await query("DESCRIBE members;");
    console.log("\n📋 Colunas na tabela 'members':");
    console.table(dMembers.rows);
    
    process.exit(0);
  } catch (error) {
    console.error("❌ Erro:", error);
    process.exit(1);
  }
}

testConnection();
