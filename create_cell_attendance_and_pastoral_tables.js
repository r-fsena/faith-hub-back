const mysql = require('mysql2/promise');
require('dotenv').config();

async function runMigration() {
  console.log('🚀 Iniciando criação das tabelas de Célula (Chamadas/Presenças) e Cuidado Pastoral...');

  let conn;
  try {
    conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'faith-hub'
    });

    console.log('✅ Conectado ao MySQL com sucesso!');

    // 1. Reuniões de Célula (Cabeçalho da Reunião Semanal)
    console.log('Criando tabela `cell_meetings`...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS cell_meetings (
        id VARCHAR(36) PRIMARY KEY,
        organization_id VARCHAR(50) NOT NULL,
        campus_id VARCHAR(50) NOT NULL DEFAULT 'campus_sede',
        cell_group_id VARCHAR(36) NOT NULL,
        leader_id VARCHAR(36) NULL,
        meeting_date DATE NOT NULL,
        study_topic VARCHAR(255) NULL,
        offerings_amount DECIMAL(10, 2) DEFAULT 0.00,
        notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_cell_meetings_org_cell (organization_id, cell_group_id),
        INDEX idx_cell_meetings_date (meeting_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ Tabela `cell_meetings` pronta!');

    // 2. Presenças dos Participantes na Reunião (Membros e Visitantes)
    console.log('Criando tabela `cell_meeting_attendees`...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS cell_meeting_attendees (
        id VARCHAR(36) PRIMARY KEY,
        organization_id VARCHAR(50) NOT NULL,
        meeting_id VARCHAR(36) NOT NULL,
        member_id VARCHAR(36) NULL,
        visitor_name VARCHAR(255) NULL,
        visitor_phone VARCHAR(20) NULL,
        status ENUM('PRESENT', 'ABSENT', 'JUSTIFIED') DEFAULT 'PRESENT',
        justification TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_attendees_meeting (meeting_id),
        INDEX idx_attendees_member (organization_id, member_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ Tabela `cell_meeting_attendees` pronta!');

    // 3. Histórico de Cuidado Pastoral e Contatos (Care Logs)
    console.log('Criando tabela `pastoral_care_logs`...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS pastoral_care_logs (
        id VARCHAR(36) PRIMARY KEY,
        organization_id VARCHAR(50) NOT NULL,
        campus_id VARCHAR(50) NULL,
        member_id VARCHAR(36) NOT NULL,
        caregiver_id VARCHAR(36) NOT NULL,
        caregiver_name VARCHAR(255) NULL,
        contact_type ENUM('WHATSAPP', 'PHONE_CALL', 'IN_PERSON_VISIT', 'PRAYER', 'OTHER') DEFAULT 'WHATSAPP',
        summary TEXT NOT NULL,
        scheduled_follow_up DATE NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_care_logs_member (organization_id, member_id),
        INDEX idx_care_logs_date (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ Tabela `pastoral_care_logs` pronta!');

    // 4. Novos Visitantes / Funil de Acolhimento
    console.log('Criando tabela `church_visitors`...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS church_visitors (
        id VARCHAR(36) PRIMARY KEY,
        organization_id VARCHAR(50) NOT NULL,
        campus_id VARCHAR(50) NOT NULL DEFAULT 'campus_sede',
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        email VARCHAR(255) NULL,
        neighborhood VARCHAR(100) NULL,
        origin_channel ENUM('SUNDAY_SERVICE', 'CELL_INVITE', 'EVENT', 'PWA_APP', 'OTHER') DEFAULT 'SUNDAY_SERVICE',
        stage ENUM('NEW', 'CONTACTED_24H', 'REFERRED_TO_CELL', 'ATTENDING_CELL', 'INTEGRATED_MEMBER', 'ARCHIVED') DEFAULT 'NEW',
        assigned_cell_id VARCHAR(36) NULL,
        assigned_leader_id VARCHAR(36) NULL,
        first_visit_date DATE NOT NULL,
        notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_visitors_org_stage (organization_id, stage)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ Tabela `church_visitors` pronta!');

    console.log('\n🎉 Todas as tabelas pastorais foram migradas com sucesso no RDS!');
  } catch (err) {
    console.error('❌ Falha na migração:', err);
  } finally {
    if (conn) await conn.end();
  }
}

runMigration();
