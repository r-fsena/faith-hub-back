const mysql = require('mysql2/promise');
require('dotenv').config();

async function runMigration() {
  console.log('🚀 Iniciando criação das tabelas de Ministérios, Voluntários e Escalas...');

  let conn;
  try {
    conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'faith-hub'
    });

    console.log('✅ Conectado ao MySQL RDS com sucesso!');

    // 1. Ministérios
    console.log('Criando tabela `ministries`...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS ministries (
        id VARCHAR(36) PRIMARY KEY,
        organization_id VARCHAR(50) NOT NULL,
        campus_id VARCHAR(50) NOT NULL DEFAULT 'campus_sede',
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) NOT NULL,
        description TEXT NULL,
        icon VARCHAR(50) DEFAULT 'Users',
        color VARCHAR(20) DEFAULT '#0f766e',
        leader_id VARCHAR(36) NULL,
        leader_name VARCHAR(150) NULL,
        status ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_ministries_org_campus (organization_id, campus_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ Tabela `ministries` pronta!');

    // 2. Funções / Posições do Ministério
    console.log('Criando tabela `ministry_roles`...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS ministry_roles (
        id VARCHAR(36) PRIMARY KEY,
        organization_id VARCHAR(50) NOT NULL,
        ministry_id VARCHAR(36) NOT NULL,
        name VARCHAR(100) NOT NULL,
        description VARCHAR(255) NULL,
        min_volunteers INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ministry_roles_min (ministry_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ Tabela `ministry_roles` pronta!');

    // 3. Bolsão de Voluntários por Ministério
    console.log('Criando tabela `ministry_volunteers`...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS ministry_volunteers (
        id VARCHAR(36) PRIMARY KEY,
        organization_id VARCHAR(50) NOT NULL,
        ministry_id VARCHAR(36) NOT NULL,
        member_id VARCHAR(36) NOT NULL,
        status ENUM('CANDIDATE', 'TRAINING', 'ACTIVE', 'PAUSED') DEFAULT 'ACTIVE',
        preferred_service_time VARCHAR(50) NULL,
        roles_csv VARCHAR(500) NULL,
        notes TEXT NULL,
        joined_at DATE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_volunteers_min (ministry_id),
        INDEX idx_volunteers_member (organization_id, member_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ Tabela `ministry_volunteers` pronta!');

    // 4. Cultos / Eventos com Escala (Service Schedules)
    console.log('Criando tabela `service_schedules`...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS service_schedules (
        id VARCHAR(36) PRIMARY KEY,
        organization_id VARCHAR(50) NOT NULL,
        campus_id VARCHAR(50) NOT NULL DEFAULT 'campus_sede',
        ministry_id VARCHAR(36) NOT NULL,
        title VARCHAR(150) NOT NULL,
        service_date DATE NOT NULL,
        service_time VARCHAR(20) NOT NULL,
        notes TEXT NULL,
        status ENUM('DRAFT', 'PUBLISHED', 'COMPLETED') DEFAULT 'DRAFT',
        created_by VARCHAR(36) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_schedules_min_date (ministry_id, service_date),
        INDEX idx_schedules_org_campus (organization_id, campus_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ Tabela `service_schedules` pronta!');

    // 5. Itens da Escala de Voluntários (Roster Items)
    console.log('Criando tabela `service_roster_items`...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS service_roster_items (
        id VARCHAR(36) PRIMARY KEY,
        organization_id VARCHAR(50) NOT NULL,
        schedule_id VARCHAR(36) NOT NULL,
        role_id VARCHAR(36) NOT NULL,
        member_id VARCHAR(36) NOT NULL,
        status ENUM('PENDING', 'ACCEPTED', 'DECLINED', 'SWAP_REQUESTED') DEFAULT 'PENDING',
        decline_reason VARCHAR(255) NULL,
        confirmed_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_roster_schedule (schedule_id),
        INDEX idx_roster_member (organization_id, member_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ Tabela `service_roster_items` pronta!');

    // SEED INICIAL: Criar ministérios padrão caso a tabela esteja vazia
    const [existingMinistries] = await conn.query('SELECT COUNT(*) as count FROM ministries');
    if (existingMinistries[0].count === 0) {
      console.log('🌱 Populando ministérios e funções padrão...');
      const defaultOrgId = 'org_default';

      const seeds = [
        {
          id: 'min_louvor',
          name: 'Louvor & Adoração',
          slug: 'louvor',
          description: 'Músicos, cantores e ministros de louvor para os cultos e eventos.',
          icon: 'Music',
          color: '#8b5cf6',
          roles: ['Vocal Líder', 'Backing Vocal', 'Teclado', 'Bateria', 'Guitarra', 'Violão', 'Baixo']
        },
        {
          id: 'min_midia',
          name: 'Mídia & Transmissão',
          slug: 'midia',
          description: 'Transmissão ao vivo, câmeras, som, projeção de letras e iluminação.',
          icon: 'Video',
          color: '#3b82f6',
          roles: ['Operador de Áudio/Som', 'Câmera 1 (Principal)', 'Câmera 2 (Móvel)', 'Corte/OBS', 'Projeção (Holyrics)', 'Iluminação']
        },
        {
          id: 'min_kids',
          name: 'Ministério Infantil (Kids)',
          slug: 'kids',
          description: 'Cuidado, ensino bíblico e segurança de crianças durante os cultos.',
          icon: 'Smile',
          color: '#f59e0b',
          roles: ['Berçário (0 a 2 anos)', 'Maternal (3 a 5 anos)', 'Juniores (6 a 10 anos)', 'Apoio/Recreação', 'Recepção Kids']
        },
        {
          id: 'min_recepcao',
          name: 'Recepção & Boas-Vindas',
          slug: 'recepcao',
          description: 'Acolhimento de membros e visitantes na entrada da igreja e nave.',
          icon: 'Heart',
          color: '#ec4899',
          roles: ['Porta Principal', 'Acolhimento da Nave', 'Entrega de Bíblias/Folhetos', 'Balcão de Novos Visitantes']
        },
        {
          id: 'min_diaconia',
          name: 'Diaconia & Tesouraria',
          slug: 'diaconia',
          description: 'Serviço da Santa Ceia, apoio ao altar e contagem de dízimos/ofertas.',
          icon: 'Shield',
          color: '#0f766e',
          roles: ['Serviço da Santa Ceia', 'Apoio ao Altar/Púlpito', 'Contagem de Ofertas & Dízimos']
        },
        {
          id: 'min_intercessao',
          name: 'Intercessão & Oração',
          slug: 'intercessao',
          description: 'Equipe de apoio espiritual e cobertura em oração antes e durante os cultos.',
          icon: 'Sun',
          color: '#10b981',
          roles: ['Intercessão Pré-Culto', 'Oração no Altar pós-mensagem']
        }
      ];

      for (const m of seeds) {
        await conn.query(`
          INSERT INTO ministries (id, organization_id, campus_id, name, slug, description, icon, color, status)
          VALUES (?, ?, 'campus_sede', ?, ?, ?, ?, ?, 'ACTIVE')
        `, [m.id, defaultOrgId, m.name, m.slug, m.description, m.icon, m.color]);

        for (let i = 0; i < m.roles.length; i++) {
          const roleId = `role_${m.slug}_${i + 1}`;
          await conn.query(`
            INSERT INTO ministry_roles (id, organization_id, ministry_id, name, min_volunteers)
            VALUES (?, ?, ?, ?, 1)
          `, [roleId, defaultOrgId, m.id, m.roles[i]]);
        }
      }
      console.log('✅ Ministérios e funções padrão populados com sucesso!');
    }

    console.log('\n🎉 Todas as tabelas de Ministérios e Escalas estão prontas no RDS!');
  } catch (err) {
    console.error('❌ Falha na migração de ministérios:', err);
  } finally {
    if (conn) await conn.end();
  }
}

runMigration();
