const mysql = require('mysql2/promise');
require('dotenv').config();

async function migrateAll() {
  console.log('🚀 Iniciando criação completa de todas as tabelas no RDS MySQL...');

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub'
  });

  const queries = [
    // 1. cell_groups
    `CREATE TABLE IF NOT EXISTS cell_groups (
      id VARCHAR(36) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      leader_id VARCHAR(36),
      description TEXT,
      address VARCHAR(500),
      neighborhood VARCHAR(100),
      meeting_day VARCHAR(50),
      meeting_time VARCHAR(20),
      whatsapp_contact VARCHAR(20),
      status VARCHAR(50) DEFAULT 'ACTIVE',
      focus VARCHAR(50) DEFAULT '@GERAL',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    // 2. members
    `CREATE TABLE IF NOT EXISTS members (
      id VARCHAR(36) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      role VARCHAR(50) DEFAULT 'MEMBER', 
      status VARCHAR(50) DEFAULT 'ACTIVE',
      cpf VARCHAR(14),
      baptism_date DATE,
      cell_group_id VARCHAR(36),
      pending_cell_group_id VARCHAR(36) NULL,
      phone VARCHAR(20),
      activation_date TIMESTAMP NULL,
      invited_by VARCHAR(36),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (cell_group_id) REFERENCES cell_groups(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    // 3. broadcasts
    `CREATE TABLE IF NOT EXISTS broadcasts (
      id VARCHAR(36) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      observation TEXT,
      youtube_url VARCHAR(500) NOT NULL,
      is_available BOOLEAN DEFAULT FALSE,
      scheduled_for DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    // 4. events
    `CREATE TABLE IF NOT EXISTS events (
      id VARCHAR(36) PRIMARY KEY,
      type INT DEFAULT 0,
      is_featured TINYINT(1) DEFAULT 0,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      image_url VARCHAR(1000),
      video_url VARCHAR(500),
      start_date DATETIME NOT NULL,
      end_date DATETIME NOT NULL,
      location VARCHAR(500),
      status ENUM('DRAFT', 'PUBLISHED', 'CANCELED', 'FINISHED') DEFAULT 'PUBLISHED',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    // 5. event_lots
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    // 6. event_tickets
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    // 7. pdv_products
    `CREATE TABLE IF NOT EXISTS pdv_products (
      id VARCHAR(36) PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      description TEXT,
      price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
      category VARCHAR(50) NOT NULL DEFAULT 'Geral',
      image_urls TEXT,
      status ENUM('ACTIVE', 'INACTIVE', 'DRAFT') DEFAULT 'ACTIVE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    // 8. pdv_orders
    `CREATE TABLE IF NOT EXISTS pdv_orders (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      user_name VARCHAR(150) NOT NULL,
      customer_phone VARCHAR(50) DEFAULT '',
      status ENUM('RECEBIDO', 'PREPARANDO', 'PRONTO', 'ENTREGUE', 'CANCELADO') DEFAULT 'RECEBIDO',
      payment_method VARCHAR(50) DEFAULT 'PIX',
      payment_status VARCHAR(50) DEFAULT 'PENDING',
      delivery_method ENUM('church', 'home') NOT NULL DEFAULT 'church',
      delivery_details TEXT NOT NULL,
      items_json JSON NOT NULL,
      total_price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    // 9. devotionals
    `CREATE TABLE IF NOT EXISTS devotionals (
      id VARCHAR(36) PRIMARY KEY,
      available_date DATE NOT NULL,
      title VARCHAR(255) NOT NULL,
      source_type VARCHAR(50) DEFAULT 'LOCAL',
      source_name VARCHAR(100),
      suggested_song_title VARCHAR(255),
      suggested_song_youtube_id VARCHAR(50),
      central_text TEXT,
      context_text TEXT,
      prayer_indication TEXT,
      pastoral_author_name VARCHAR(100),
      pastoral_author_role VARCHAR(100),
      pastoral_author_avatar VARCHAR(500),
      pastoral_comment TEXT,
      status ENUM('DRAFT', 'PUBLISHED', 'ARCHIVED') DEFAULT 'PUBLISHED',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    // 10. devotional_notes
    `CREATE TABLE IF NOT EXISTS devotional_notes (
      id VARCHAR(36) PRIMARY KEY,
      devotional_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      note_text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_devo_user (devotional_id, user_id),
      FOREIGN KEY (devotional_id) REFERENCES devotionals(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    // 11. studies
    `CREATE TABLE IF NOT EXISTS studies (
      id VARCHAR(36) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      content_type ENUM('VIDEO', 'PDF', 'TEXT') DEFAULT 'TEXT',
      link VARCHAR(255),
      date_published DATE,
      status ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
      target_group_id VARCHAR(36) NULL,
      content_text TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (target_group_id) REFERENCES cell_groups(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    // 12. board_posts
    `CREATE TABLE IF NOT EXISTS board_posts (
      id VARCHAR(36) PRIMARY KEY,
      cell_group_id VARCHAR(36),
      author_id VARCHAR(36) NOT NULL,
      author_name VARCHAR(255) NOT NULL,
      content_text TEXT,
      media_url VARCHAR(255),
      media_type ENUM('NONE', 'IMAGE', 'VIDEO') DEFAULT 'NONE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cell_group_id) REFERENCES cell_groups(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    // 13. cell_partilhas
    `CREATE TABLE IF NOT EXISTS cell_partilhas (
      id VARCHAR(36) PRIMARY KEY,
      cell_group_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      user_name VARCHAR(150) NOT NULL,
      item_name VARCHAR(255) NOT NULL,
      quantity VARCHAR(100),
      event_date DATE NOT NULL,
      is_confirmed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cell_group_id) REFERENCES cell_groups(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    // 14. church_settings (Whitelabel)
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

    // Inserção default
    `INSERT IGNORE INTO church_settings (id, church_name, pwa_slug) 
     VALUES ('default_church', 'Igreja Faith Hub', 'faithhub');`,

    // 15. payment_gateway_settings (Pagar.me)
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

    `INSERT IGNORE INTO payment_gateway_settings (id, environment) 
     VALUES ('default_gateway', 'test');`,

    // 16. prayers
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

    // 17. prayer_intercessions
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
      const firstLine = q.trim().split('\n')[0];
      console.log('✅ Executado:', firstLine);
    } catch (err) {
      console.error('❌ Erro na query:', err.message);
    }
  }

  const [tables] = await connection.query('SHOW TABLES;');
  console.log('\n🎉 TODAS AS 17 TABELAS FORAM CRIADAS NO BANCO:');
  console.log(tables.map(r => Object.values(r)[0]));

  await connection.end();
}

migrateAll().catch(console.error);
