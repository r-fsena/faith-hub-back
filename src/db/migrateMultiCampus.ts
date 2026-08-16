import { pool } from './index';

async function migrateMultiCampus() {
  console.log('🚀 Iniciando Migração Multi-Organização & Multi-Unidade (Campi)...');

  try {
    // 1. Criar tabela de Organizações
    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('✔ Tabela `organizations` criada/verificada com sucesso.');

    // 2. Criar tabela de Campi (Unidades / Filiais)
    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('✔ Tabela `campuses` criada/verificada com sucesso.');

    // 3. Inserir Organização Padrão e Campus Sede (se não existirem)
    await pool.query(`
      INSERT INTO organizations (id, name, slug, plan, primary_color, secondary_color, status)
      VALUES ('org_default', 'Igreja Faith Hub', 'faithhub', 'ENTERPRISE', '#0f766e', '#14b8a6', 'ACTIVE')
      ON DUPLICATE KEY UPDATE name = VALUES(name);
    `);

    await pool.query(`
      INSERT INTO campuses (id, organization_id, name, slug, is_headquarters, pastor_name, status)
      VALUES ('campus_sede', 'org_default', 'Sede Principal', 'sede', TRUE, 'Pastor Presidente', 'ACTIVE')
      ON DUPLICATE KEY UPDATE name = VALUES(name);
    `);
    console.log('✔ Organização padrão (`org_default`) e Campus Sede (`campus_sede`) prontos.');

    // 4. Adicionar organization_id e campus_id nas tabelas existentes de forma segura
    const tablesToAlter = [
      'members',
      'cell_groups',
      'events',
      'pdv_products',
      'pdv_orders',
      'devotionals',
      'broadcasts',
      'studies',
      'partilhas',
      'prayers',
      'church_settings'
    ];

    for (const tableName of tablesToAlter) {
      try {
        // Verifica se a tabela existe
        const [tableCheck]: any = await pool.query(`
          SELECT TABLE_NAME FROM information_schema.TABLES 
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        `, [tableName]);

        if (tableCheck.length === 0) {
          console.log(`ℹ Tabela \`${tableName}\` não encontrada, pulando.`);
          continue;
        }

        // Verifica se organization_id já existe
        const [colOrgCheck]: any = await pool.query(`
          SELECT COLUMN_NAME FROM information_schema.COLUMNS 
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'organization_id'
        `, [tableName]);

        if (colOrgCheck.length === 0) {
          await pool.query(`
            ALTER TABLE ${tableName} 
            ADD COLUMN organization_id VARCHAR(36) NOT NULL DEFAULT 'org_default';
          `);
          console.log(`✔ Coluna \`organization_id\` adicionada à tabela \`${tableName}\`.`);
        }

        // Verifica se campus_id já existe
        const [colCampCheck]: any = await pool.query(`
          SELECT COLUMN_NAME FROM information_schema.COLUMNS 
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'campus_id'
        `, [tableName]);

        if (colCampCheck.length === 0) {
          await pool.query(`
            ALTER TABLE ${tableName} 
            ADD COLUMN campus_id VARCHAR(36) NULL DEFAULT 'campus_sede';
          `);
          console.log(`✔ Coluna \`campus_id\` adicionada à tabela \`${tableName}\`.`);
        }
      } catch (colErr: any) {
        console.warn(`Aviso ao alterar tabela \`${tableName}\`:`, colErr.message);
      }
    }

    console.log('🎉 Migração Multi-Organização & Multi-Campus concluída com sucesso!');
  } catch (error) {
    console.error('❌ Erro durante a migração:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrateMultiCampus();
