const mysql = require('mysql2/promise');
require('dotenv').config();

async function runMultiCampusMigration() {
  console.log('🚀 Iniciando Migração Multi-Organização & Multi-Unidade (Campi)...');

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub'
  });

  try {
    // 1. Criar tabela organizations
    await connection.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(100) UNIQUE NOT NULL,
        cnpj VARCHAR(20),
        plan VARCHAR(50) DEFAULT 'PRO',
        primary_color VARCHAR(20) DEFAULT '#0f766e',
        secondary_color VARCHAR(20) DEFAULT '#14b8a6',
        logo_url VARCHAR(500),
        status VARCHAR(50) DEFAULT 'ACTIVE',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✔ Tabela `organizations` criada/verificada.');

    // 2. Criar tabela campuses
    await connection.query(`
      CREATE TABLE IF NOT EXISTS campuses (
        id VARCHAR(36) PRIMARY KEY,
        organization_id VARCHAR(36) NOT NULL,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(100) NOT NULL,
        is_headquarters BOOLEAN DEFAULT FALSE,
        pastor_name VARCHAR(255),
        phone VARCHAR(20),
        whatsapp VARCHAR(20),
        email VARCHAR(255),
        address VARCHAR(500),
        neighborhood VARCHAR(100),
        city VARCHAR(100),
        state VARCHAR(10),
        status VARCHAR(50) DEFAULT 'ACTIVE',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        UNIQUE KEY uq_org_campus_slug (organization_id, slug)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✔ Tabela `campuses` criada/verificada.');

    // 3. Inserir Organização Padrão e Campus Sede
    await connection.query(`
      INSERT INTO organizations (id, name, slug, plan, primary_color, secondary_color, status)
      VALUES ('org_default', 'Igreja Faith Hub', 'faithhub', 'ENTERPRISE', '#0f766e', '#14b8a6', 'ACTIVE')
      ON DUPLICATE KEY UPDATE name = VALUES(name);
    `);

    await connection.query(`
      INSERT INTO campuses (id, organization_id, name, slug, is_headquarters, pastor_name, status)
      VALUES ('campus_sede', 'org_default', 'Sede Principal', 'sede', TRUE, 'Pastor Presidente', 'ACTIVE')
      ON DUPLICATE KEY UPDATE name = VALUES(name);
    `);
    console.log('✔ Organização padrão (`org_default`) e Campus Sede (`campus_sede`) prontos.');

    // 4. Adicionar organization_id e campus_id nas tabelas existentes
    const tables = [
      'members',
      'cell_groups',
      'events',
      'pdv_products',
      'pdv_orders',
      'devotionals',
      'broadcasts',
      'studies',
      'cell_partilhas',
      'prayers',
      'church_settings'
    ];

    for (const table of tables) {
      try {
        const [tCheck] = await connection.query(
          `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
          [table]
        );
        if (tCheck.length === 0) continue;

        // Check organization_id
        const [colOrg] = await connection.query(
          `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'organization_id'`,
          [table]
        );
        if (colOrg.length === 0) {
          await connection.query(`ALTER TABLE ${table} ADD COLUMN organization_id VARCHAR(36) NOT NULL DEFAULT 'org_default';`);
          console.log(`✔ Adicionado \`organization_id\` na tabela \`${table}\`.`);
        }

        // Check campus_id
        const [colCamp] = await connection.query(
          `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'campus_id'`,
          [table]
        );
        if (colCamp.length === 0) {
          await connection.query(`ALTER TABLE ${table} ADD COLUMN campus_id VARCHAR(36) NULL DEFAULT 'campus_sede';`);
          console.log(`✔ Adicionado \`campus_id\` na tabela \`${table}\`.`);
        }
      } catch (err) {
        console.warn(`Aviso em \`${table}\`:`, err.message);
      }
    }

    const [allTables] = await connection.query('SHOW TABLES;');
    console.log('\n🎉 TABELAS ATUAIS NO BANCO DE DADOS:');
    console.log(allTables.map(r => Object.values(r)[0]));
    console.log('\n✔ Migração finalizada com êxito!');
  } catch (err) {
    console.error('❌ Erro na migração:', err);
  } finally {
    await connection.end();
  }
}

runMultiCampusMigration();
