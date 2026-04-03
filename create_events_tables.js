const mysql = require("mysql2/promise");
require('dotenv').config();

async function createEventsTables() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub',
    ssl: { rejectUnauthorized: false }
  });

  const queries = [
    `CREATE TABLE IF NOT EXISTS events (
      id VARCHAR(36) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      image_url VARCHAR(1000),
      start_date DATETIME NOT NULL,
      end_date DATETIME NOT NULL,
      location VARCHAR(500),
      status ENUM('DRAFT', 'PUBLISHED', 'CANCELED', 'FINISHED') DEFAULT 'PUBLISHED',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS event_lots (
      id VARCHAR(36) PRIMARY KEY,
      event_id VARCHAR(36) NOT NULL,
      name VARCHAR(100) NOT NULL,
      price DECIMAL(10, 2) DEFAULT 0.00,
      total_capacity INT NOT NULL,
      available_capacity INT NOT NULL,
      sales_start_date DATETIME,
      sales_end_date DATETIME,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS event_tickets (
      id VARCHAR(36) PRIMARY KEY,
      event_id VARCHAR(36) NOT NULL,
      lot_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      status ENUM('PENDING', 'PAID', 'CANCELED', 'USED') DEFAULT 'PENDING',
      qrcode_token VARCHAR(255) UNIQUE NOT NULL,
      price_paid DECIMAL(10, 2) DEFAULT 0.00,
      scanned_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (event_id) REFERENCES events(id),
      FOREIGN KEY (lot_id) REFERENCES event_lots(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
  ];

  try {
    for (let q of queries) {
      await connection.query(q);
      console.log("Executado: ", q.substring(0, 50), "...");
    }
    console.log("Tabelas de Eventos e Ingressos criadas com sucesso!");
  } catch (err) {
    console.error("Erro ao criar tabelas de eventos:", err);
  }
  await connection.end();
}

createEventsTables().catch(console.error);
