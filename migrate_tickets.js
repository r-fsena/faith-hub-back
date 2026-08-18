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

  console.log('Connected to MySQL DB:', process.env.DB_HOST);

  const columnsToAdd = [
    { name: 'attendee_name', type: 'VARCHAR(255) NULL' },
    { name: 'attendee_whatsapp', type: 'VARCHAR(50) NULL' },
    { name: 'attendee_cpf', type: 'VARCHAR(20) NULL' },
    { name: 'attendee_email', type: 'VARCHAR(255) NULL' },
    { name: 'dietary_notes', type: 'TEXT NULL' },
    { name: 'short_code', type: 'VARCHAR(20) NULL' },
    { name: 'scanned_by', type: 'VARCHAR(150) NULL' }
  ];

  for (const col of columnsToAdd) {
    try {
      await connection.query(`ALTER TABLE event_tickets ADD COLUMN ${col.name} ${col.type};`);
      console.log(`✅ Adicionada coluna ${col.name}`);
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log(`ℹ️ Coluna ${col.name} já existe.`);
      } else {
        console.warn(`Aviso ao adicionar ${col.name}:`, e.message);
      }
    }
  }

  await connection.end();
  console.log('Migration concluída!');
}

run().catch(err => {
  console.error('Erro na migration:', err);
  process.exit(1);
});
