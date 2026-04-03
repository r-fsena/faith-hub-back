const mysql = require("mysql2/promise");
require('dotenv').config();

async function createBoardPostsTable() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub',
    ssl: { rejectUnauthorized: false }
  });

  const query = `
    CREATE TABLE IF NOT EXISTS board_posts (
      id VARCHAR(36) PRIMARY KEY,
      cell_group_id VARCHAR(36),
      author_id VARCHAR(36) NOT NULL,
      author_name VARCHAR(255) NOT NULL,
      content_text TEXT,
      media_url VARCHAR(255),
      media_type ENUM('NONE', 'IMAGE', 'VIDEO') DEFAULT 'NONE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cell_group_id) REFERENCES cell_groups(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
  `;

  try {
    await connection.query(query);
    console.log("Tabela board_posts criada com sucesso!");
  } catch (err) {
    console.error("Erro ao criar tabela:", err);
  }
  await connection.end();
}

createBoardPostsTable().catch(console.error);
