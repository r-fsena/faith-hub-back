const mysql = require("mysql2/promise");
require('dotenv').config();

async function createStudiesTable() {
  console.log("Conectando ao banco de dados...");
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub',
    ssl: { rejectUnauthorized: false }
  });

  const query = `
    CREATE TABLE IF NOT EXISTS studies (
      id VARCHAR(36) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      content_type ENUM('VIDEO', 'PDF', 'TEXT') DEFAULT 'TEXT',
      link VARCHAR(255),
      date_published DATE,
      status ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
      target_group_id VARCHAR(36) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (target_group_id) REFERENCES cell_groups(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
  `;

  console.log("Criando a tabela studies...");
  await connection.query(query);
  console.log("Tabela 'studies' criada com sucesso! 🚀");
  await connection.end();
}

createStudiesTable().catch(console.error);
