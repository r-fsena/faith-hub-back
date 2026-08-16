const mysql = require('mysql2/promise');
require('dotenv').config();

async function runMigrations() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub',
    ssl: { rejectUnauthorized: false }
  });

  console.log('Conectado ao MySQL RDS para executar migrações...');

  const queries = [
    // 1. Tabela church_settings (Whitelabel)
    `CREATE TABLE IF NOT EXISTS church_settings (
      id VARCHAR(36) PRIMARY KEY,
      church_name VARCHAR(255) NOT NULL DEFAULT 'Igreja Faith Hub',
      slogan VARCHAR(255) DEFAULT 'Um lugar de fé, amor e comunhão',
      cnpj VARCHAR(30) DEFAULT '',
      pastor_name VARCHAR(150) DEFAULT 'Pr. Titular',
      phone VARCHAR(30) DEFAULT '',
      whatsapp VARCHAR(30) DEFAULT '',
      email VARCHAR(150) DEFAULT '',
      address_street VARCHAR(255) DEFAULT '',
      address_number VARCHAR(50) DEFAULT '',
      address_neighborhood VARCHAR(100) DEFAULT '',
      address_city VARCHAR(100) DEFAULT '',
      address_state VARCHAR(50) DEFAULT '',
      address_zip VARCHAR(20) DEFAULT '',
      instagram_url VARCHAR(255) DEFAULT '',
      youtube_url VARCHAR(255) DEFAULT '',
      facebook_url VARCHAR(255) DEFAULT '',
      website_url VARCHAR(255) DEFAULT '',
      logo_icon_url TEXT,
      logo_header_url TEXT,
      banner_url TEXT,
      primary_color VARCHAR(20) DEFAULT '#0f766e',
      secondary_color VARCHAR(20) DEFAULT '#14b8a6',
      pwa_theme_color VARCHAR(20) DEFAULT '#0f766e',
      pwa_short_name VARCHAR(50) DEFAULT 'Faith Hub',
      pwa_slug VARCHAR(50) DEFAULT 'faithhub',
      offline_mode BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    // Inserção default se não existir
    `INSERT IGNORE INTO church_settings (id, church_name, pwa_slug) 
     VALUES ('default_church', 'Igreja Faith Hub', 'faithhub');`,

    // 2. Tabela payment_gateway_settings (Pagar.me)
    `CREATE TABLE IF NOT EXISTS payment_gateway_settings (
      id VARCHAR(36) PRIMARY KEY,
      environment ENUM('test', 'production') DEFAULT 'test',
      api_key VARCHAR(255) DEFAULT '',
      encryption_key VARCHAR(255) DEFAULT '',
      recipient_id VARCHAR(255) DEFAULT '',
      bank_code VARCHAR(10) DEFAULT '001',
      bank_name VARCHAR(100) DEFAULT 'Banco do Brasil',
      agency VARCHAR(20) DEFAULT '',
      account VARCHAR(30) DEFAULT '',
      account_digit VARCHAR(5) DEFAULT '',
      document_number VARCHAR(30) DEFAULT '',
      legal_name VARCHAR(255) DEFAULT '',
      pix_key_type VARCHAR(20) DEFAULT 'CNPJ',
      pix_key VARCHAR(100) DEFAULT '',
      auto_split_enabled BOOLEAN DEFAULT FALSE,
      fee_percentage DECIMAL(5,2) DEFAULT 0.00,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    // Inserção default se não existir
    `INSERT IGNORE INTO payment_gateway_settings (id, environment) 
     VALUES ('default_gateway', 'test');`,

    // 3. Tabela prayers (Pedidos de Oração)
    `CREATE TABLE IF NOT EXISTS prayers (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NULL,
      author_name VARCHAR(150) NOT NULL DEFAULT 'Membro',
      is_anonymous BOOLEAN DEFAULT FALSE,
      category ENUM('Família', 'Saúde', 'Finanças', 'Espiritual', 'Gratidão', 'Outros') DEFAULT 'Outros',
      privacy ENUM('PUBLIC', 'CONFIDENTIAL') DEFAULT 'PUBLIC',
      content TEXT NOT NULL,
      praying_count INT NOT NULL DEFAULT 0,
      status ENUM('APPROVED', 'PENDING', 'ARCHIVED') DEFAULT 'APPROVED',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    // 4. Tabela prayer_intercessions (Controle de quem já clicou em 'orando')
    `CREATE TABLE IF NOT EXISTS prayer_intercessions (
      id VARCHAR(36) PRIMARY KEY,
      prayer_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_prayer_user (prayer_id, user_id),
      FOREIGN KEY (prayer_id) REFERENCES prayers(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`
  ];

  for (let q of queries) {
    try {
      await connection.query(q);
      console.log('Query executada com sucesso:', q.slice(0, 50).replace(/\n/g, ' '), '...');
    } catch (err) {
      console.error('Erro na query:', err.message);
    }
  }

  // Alterações seguras em tabelas existentes
  try {
    const [colsEvents] = await connection.query(`SHOW COLUMNS FROM events LIKE 'type'`);
    if (colsEvents.length === 0) {
      await connection.query(`ALTER TABLE events ADD COLUMN type INT DEFAULT 0 AFTER id`);
      console.log('Coluna events.type adicionada.');
    }
  } catch (e) { console.log('events.type já existe ou erro:', e.message); }

  try {
    const [colsEventsFeat] = await connection.query(`SHOW COLUMNS FROM events LIKE 'is_featured'`);
    if (colsEventsFeat.length === 0) {
      await connection.query(`ALTER TABLE events ADD COLUMN is_featured TINYINT(1) DEFAULT 0 AFTER type`);
      console.log('Coluna events.is_featured adicionada.');
    }
  } catch (e) { console.log('events.is_featured já existe ou erro:', e.message); }

  try {
    const [colsEventsVideo] = await connection.query(`SHOW COLUMNS FROM events LIKE 'video_url'`);
    if (colsEventsVideo.length === 0) {
      await connection.query(`ALTER TABLE events ADD COLUMN video_url VARCHAR(500) AFTER image_url`);
      console.log('Coluna events.video_url adicionada.');
    }
  } catch (e) { console.log('events.video_url já existe ou erro:', e.message); }

  try {
    const [colsPdvPhone] = await connection.query(`SHOW COLUMNS FROM pdv_orders LIKE 'customer_phone'`);
    if (colsPdvPhone.length === 0) {
      await connection.query(`ALTER TABLE pdv_orders ADD COLUMN customer_phone VARCHAR(50) DEFAULT '' AFTER user_name`);
      console.log('Coluna pdv_orders.customer_phone adicionada.');
    }
  } catch (e) { console.log('pdv_orders.customer_phone já existe ou erro:', e.message); }

  try {
    const [colsPdvMethod] = await connection.query(`SHOW COLUMNS FROM pdv_orders LIKE 'payment_method'`);
    if (colsPdvMethod.length === 0) {
      await connection.query(`ALTER TABLE pdv_orders ADD COLUMN payment_method VARCHAR(50) DEFAULT 'PIX' AFTER status`);
      console.log('Coluna pdv_orders.payment_method adicionada.');
    }
  } catch (e) { console.log('pdv_orders.payment_method já existe ou erro:', e.message); }

  try {
    const [colsPdvPayStatus] = await connection.query(`SHOW COLUMNS FROM pdv_orders LIKE 'payment_status'`);
    if (colsPdvPayStatus.length === 0) {
      await connection.query(`ALTER TABLE pdv_orders ADD COLUMN payment_status VARCHAR(50) DEFAULT 'PENDING' AFTER payment_method`);
      console.log('Coluna pdv_orders.payment_status adicionada.');
    }
  } catch (e) { console.log('pdv_orders.payment_status já existe ou erro:', e.message); }

  await connection.end();
  console.log('Migrações concluídas com sucesso!');
}

runMigrations().catch(console.error);
