const mysql = require('mysql2/promise');
require('dotenv').config();

async function migrateMemberFields() {
  console.log('🚀 Iniciando adição dos novos campos na tabela members...');

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub',
    ssl: { rejectUnauthorized: false }
  });

  const columnsToAdd = [
    { name: 'birth_date', type: 'DATE NULL' },
    { name: 'address_street', type: 'VARCHAR(255) NULL' },
    { name: 'address_number', type: 'VARCHAR(20) NULL' },
    { name: 'address_complement', type: 'VARCHAR(100) NULL' },
    { name: 'address_neighborhood', type: 'VARCHAR(100) NULL' },
    { name: 'address_city', type: 'VARCHAR(100) NULL' },
    { name: 'address_state', type: 'VARCHAR(10) NULL' },
    { name: 'address_zip', type: 'VARCHAR(20) NULL' }
  ];

  for (const col of columnsToAdd) {
    try {
      const [existing] = await connection.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS 
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'members' AND COLUMN_NAME = ?`,
        [col.name]
      );

      if (existing.length === 0) {
        await connection.query(`ALTER TABLE members ADD COLUMN ${col.name} ${col.type}`);
        console.log(`✅ Coluna adicionada: members.${col.name} (${col.type})`);
      } else {
        console.log(`ℹ️ Coluna já existe: members.${col.name}`);
      }
    } catch (err) {
      console.error(`❌ Erro ao adicionar coluna ${col.name}:`, err.message);
    }
  }

  // Verificar estrutura final
  const [cols] = await connection.query(`SHOW COLUMNS FROM members;`);
  console.log('\n📋 Colunas atuais da tabela members:');
  console.log(cols.map(c => `${c.Field} (${c.Type})`));

  await connection.end();
  console.log('\n🎉 Migração concluída com sucesso!');
}

migrateMemberFields().catch(console.error);
