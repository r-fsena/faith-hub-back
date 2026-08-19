const mysql = require('mysql2/promise');
require('dotenv').config();

async function runMigration() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub'
  });

  console.log(' Conectado ao RDS MySQL. Criando tabelas financeiras...');

  // 1. Transações Financeiras da Igreja (Dízimos, Ofertas, Vendas, Despesas)
  await conn.query(`
    CREATE TABLE IF NOT EXISTS church_financial_transactions (
      id VARCHAR(36) PRIMARY KEY,
      organization_id VARCHAR(50) NOT NULL,
      campus_id VARCHAR(50) NULL,
      type ENUM('INCOME', 'EXPENSE') NOT NULL,
      category VARCHAR(80) NOT NULL,
      description VARCHAR(255) NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      payment_method ENUM('PIX', 'CREDIT_CARD', 'DEBIT_CARD', 'BOLETO', 'CASH', 'TRANSFER') NOT NULL DEFAULT 'PIX',
      status ENUM('PAID', 'PENDING', 'CANCELLED') DEFAULT 'PAID',
      member_id VARCHAR(36) NULL,
      member_name VARCHAR(150) NULL,
      project_id VARCHAR(36) NULL,
      origin_module ENUM('TITHES', 'PDV', 'EVENTS', 'MANUAL', 'CELL') DEFAULT 'MANUAL',
      receipt_url TEXT NULL,
      due_date DATE NULL,
      payment_date DATE NOT NULL,
      created_by VARCHAR(150) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_org_date (organization_id, payment_date),
      INDEX idx_type_status (organization_id, type, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  console.log('✓ Tabela church_financial_transactions criada/verificada.');

  // 2. Projetos Especiais & Campanhas de Arrecadação com Metas
  await conn.query(`
    CREATE TABLE IF NOT EXISTS church_special_projects (
      id VARCHAR(36) PRIMARY KEY,
      organization_id VARCHAR(50) NOT NULL,
      campus_id VARCHAR(50) NULL,
      title VARCHAR(150) NOT NULL,
      description TEXT NULL,
      image_url TEXT NULL,
      target_amount DECIMAL(10,2) NOT NULL,
      collected_amount DECIMAL(10,2) DEFAULT 0.00,
      start_date DATE NOT NULL,
      end_date DATE NULL,
      pix_key VARCHAR(100) NULL,
      status ENUM('ACTIVE', 'COMPLETED', 'PAUSED') DEFAULT 'ACTIVE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_proj_org (organization_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  console.log('✓ Tabela church_special_projects criada/verificada.');

  // 3. Faturas de Assinatura SaaS Faith-Hub (Mensalidades das Igrejas)
  await conn.query(`
    CREATE TABLE IF NOT EXISTS saas_invoices (
      id VARCHAR(36) PRIMARY KEY,
      subscription_id VARCHAR(100) NOT NULL,
      organization_id VARCHAR(50) NOT NULL,
      plan_id VARCHAR(50) NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      due_date DATE NOT NULL,
      paid_at DATETIME NULL,
      status ENUM('PAID', 'PENDING', 'OVERDUE', 'CANCELLED') DEFAULT 'PENDING',
      payment_method VARCHAR(20) DEFAULT 'PIX',
      payment_link TEXT NULL,
      pix_qr_code TEXT NULL,
      pix_copy_paste TEXT NULL,
      receipt_url TEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_inv_org (organization_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  console.log('✓ Tabela saas_invoices criada/verificada.');

  // Buscar organizações para inserir sementes de dados demonstrativos
  const [orgs] = await conn.query('SELECT id, name FROM organizations LIMIT 5');
  
  if (orgs.length > 0) {
    const orgId = orgs[0].id;

    // Verificar se já há transações na organização
    const [existingT] = await conn.query('SELECT COUNT(*) as total FROM church_financial_transactions WHERE organization_id = ?', [orgId]);
    if (existingT[0].total === 0) {
      console.log(`Inserindo transações de exemplo para org: ${orgId}`);
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const lastWeek = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

      await conn.query(`
        INSERT INTO church_financial_transactions 
        (id, organization_id, type, category, description, amount, payment_method, status, member_name, origin_module, payment_date)
        VALUES
        (UUID(), ?, 'INCOME', 'Dízimo', 'Dízimo Mensal - Culto de Celebração', 850.00, 'PIX', 'PAID', 'Carlos Eduardo Silva', 'TITHES', ?),
        (UUID(), ?, 'INCOME', 'Dízimo', 'Dízimo Fidelidade', 1200.00, 'TRANSFER', 'PAID', 'Mariana Alencar Santos', 'TITHES', ?),
        (UUID(), ?, 'INCOME', 'Oferta', 'Oferta de Gratidão de Domingo', 450.00, 'CASH', 'PAID', 'Oferta Geral do Culto', 'MANUAL', ?),
        (UUID(), ?, 'INCOME', 'Cantina / PDV', 'Faturamento Cantina - Culto Noturno', 680.50, 'PIX', 'PAID', 'Cantina Faith', 'PDV', ?),
        (UUID(), ?, 'INCOME', 'Eventos & Cursos', 'Inscrição Conferência de Homens', 350.00, 'CREDIT_CARD', 'PAID', 'Marcos Vinicius', 'EVENTS', ?),
        (UUID(), ?, 'EXPENSE', 'Instalações & Aluguel', 'Locação do Templo Principal', 3500.00, 'TRANSFER', 'PAID', 'Imobiliária Central', 'MANUAL', ?),
        (UUID(), ?, 'EXPENSE', 'Energia & Água', 'Conta de Energia Elétrica (Enel)', 640.20, 'BOLETO', 'PAID', 'Companhia de Energia', 'MANUAL', ?),
        (UUID(), ?, 'EXPENSE', 'Som & Mídia', 'Aquisição de Cabos e Microfones Sem Fio', 480.00, 'PIX', 'PAID', 'Loja do Som Instrumentos', 'MANUAL', ?),
        (UUID(), ?, 'EXPENSE', 'Ação Social', 'Cestas Básicas para Comunidade Local', 750.00, 'PIX', 'PAID', 'Supermercado Bom Preço', 'MANUAL', ?)
      `, [
        orgId, today,
        orgId, yesterday,
        orgId, yesterday,
        orgId, yesterday,
        orgId, lastWeek,
        orgId, lastWeek,
        orgId, lastWeek,
        orgId, today,
        orgId, today
      ]);
    }

    // Verificar projetos
    const [existingP] = await conn.query('SELECT COUNT(*) as total FROM church_special_projects WHERE organization_id = ?', [orgId]);
    if (existingP[0].total === 0) {
      console.log(`Inserindo campanhas/projetos de exemplo para org: ${orgId}`);
      await conn.query(`
        INSERT INTO church_special_projects
        (id, organization_id, title, description, target_amount, collected_amount, start_date, status)
        VALUES
        (UUID(), ?, 'Reforma e Climatização do Templo', 'Instalação de novo sistema de ar-condicionado central e reforma acústica do auditório principal.', 50000.00, 32500.00, '2026-01-10', 'ACTIVE'),
        (UUID(), ?, 'Missões no Sertão Nordestino', 'Envio de missionários e perfuração de poços artesianos para famílias no interior do sertão.', 25000.00, 18400.00, '2026-02-01', 'ACTIVE'),
        (UUID(), ?, 'Novo Espaço Kids & Berçário', 'Modernização das salas infantis, piso emborrachado e novos brinquedos pedagógicos.', 15000.00, 15000.00, '2026-01-01', 'COMPLETED')
      `, [orgId, orgId, orgId]);
    }

    // Verificar faturas SaaS
    const [existingInv] = await conn.query('SELECT COUNT(*) as total FROM saas_invoices WHERE organization_id = ?', [orgId]);
    if (existingInv[0].total === 0) {
      console.log(`Inserindo faturas de exemplo da Faith-Hub para org: ${orgId}`);
      const nextMonth = new Date(Date.now() + 15 * 86400000).toISOString().split('T')[0];
      const lastMonth = new Date(Date.now() - 15 * 86400000).toISOString().split('T')[0];

      await conn.query(`
        INSERT INTO saas_invoices
        (id, subscription_id, organization_id, plan_id, amount, due_date, paid_at, status, payment_method, pix_copy_paste)
        VALUES
        (UUID(), 'sub_faith_pro', ?, 'plan_pro', 297.00, ?, NULL, 'PENDING', 'PIX', '00020126580014br.gov.bcb.pix0136fa89c092-231a-493e-bfa1-923847294820520400005303986540297.005802BR5916FAITH HUB SAAS6009SAO PAULO62070503***6304'),
        (UUID(), 'sub_faith_pro', ?, 'plan_pro', 297.00, ?, NOW(), 'PAID', 'PIX', NULL)
      `, [orgId, nextMonth, orgId, lastMonth]);
    }
  }

  console.log('✅ Migração financeira e dados demonstrativos criados com sucesso!');
  await conn.end();
}

runMigration().catch(err => {
  console.error('❌ Erro na migração financeira:', err);
  process.exit(1);
});
