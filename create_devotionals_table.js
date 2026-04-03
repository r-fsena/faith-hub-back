const mysql = require('mysql2/promise');
require('dotenv').config();

async function createDevotionalsTables() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub',
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('Construindo tabelas de Devocionais...');
    
    await connection.query(`
      CREATE TABLE IF NOT EXISTS devotionals (
        id VARCHAR(36) PRIMARY KEY,
        available_date DATE NOT NULL,
        title VARCHAR(255) NOT NULL,
        source_type ENUM('LOCAL', 'GLOBAL') DEFAULT 'LOCAL',
        source_name VARCHAR(100),
        suggested_song_title VARCHAR(200),
        suggested_song_youtube_id VARCHAR(50),
        central_text TEXT NOT NULL,
        context_text TEXT NOT NULL,
        prayer_indication TEXT NOT NULL,
        pastoral_author_name VARCHAR(100),
        pastoral_author_role VARCHAR(100),
        pastoral_author_avatar VARCHAR(500),
        pastoral_comment TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY(available_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS devotional_notes (
        id VARCHAR(36) PRIMARY KEY,
        devotional_id VARCHAR(36) NOT NULL,
        user_id VARCHAR(36) NOT NULL,
        notes_text TEXT,
        status ENUM('pending', 'completed', 'missed') DEFAULT 'pending',
        completed_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY(devotional_id, user_id),
        FOREIGN KEY (devotional_id) REFERENCES devotionals(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    console.log('Tabelas devotionals e devotional_notes criadas com sucesso!');
  } catch (error) {
    console.error('Erro ao estruturar:', error);
  } finally {
    await connection.end();
  }
}

createDevotionalsTables();
