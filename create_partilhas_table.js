const mysql = require("mysql2/promise");
require('dotenv').config();

async function createPartilhasTable() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub',
    ssl: { rejectUnauthorized: false }
  });

  const query = `
    CREATE TABLE IF NOT EXISTS cell_partilhas (
      id VARCHAR(36) PRIMARY KEY,
      cell_group_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      item_name VARCHAR(255) NOT NULL,
      quantity VARCHAR(100),
      event_date DATE NOT NULL,
      is_confirmed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cell_group_id) REFERENCES cell_groups(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
  `;

  try {
    await connection.query(query);
    console.log("Tabela cell_partilhas (Módulo Partilha) criada com sucesso!");
  } catch (err) {
    console.error("Erro ao criar tabela:", err);
  }
  await connection.end();
}

createPartilhasTable().catch(console.error);
