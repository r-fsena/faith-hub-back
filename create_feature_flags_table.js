const mysql = require('mysql2/promise');
require('dotenv').config();

async function runFeatureFlagsMigration() {
  console.log('🚀 Iniciando migração de Feature Flags Multi-Tenant & Multi-Ambiente...');

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'faith-hub.cc7220s4ekvj.us-east-1.rds.amazonaws.com',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'admin_faith_hub',
    password: process.env.DB_PASSWORD || '30ago2015Ra!',
    database: process.env.DB_NAME || 'faith-hub',
    ssl: { rejectUnauthorized: false }
  });

  try {
    // 1. Criar tabela tenant_feature_flags
    await connection.query(`
      CREATE TABLE IF NOT EXISTS tenant_feature_flags (
        id VARCHAR(36) PRIMARY KEY,
        organization_id VARCHAR(36) NOT NULL DEFAULT 'global',
        campus_id VARCHAR(36) NULL DEFAULT NULL,
        environment ENUM('all', 'development', 'staging', 'production') NOT NULL DEFAULT 'all',
        feature_key VARCHAR(100) NOT NULL,
        is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        config_payload JSON NULL,
        category VARCHAR(50) NOT NULL DEFAULT 'Geral',
        description VARCHAR(255) NULL,
        updated_by VARCHAR(150) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_tenant_env_feature (organization_id, campus_id, environment, feature_key),
        INDEX idx_lookup (organization_id, environment, is_enabled)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✔ Tabela `tenant_feature_flags` criada/verificada com sucesso.');

    // 2. Lista completa de Feature Flags padrão do sistema (Catálogo Granular)
    const defaultFlags = [
      // Membros & Pessoas
      { key: 'members.module_enabled', cat: 'Membros', desc: 'Habilita o módulo completo de membros e diretório', def: 1 },
      { key: 'members.self_registration', cat: 'Membros', desc: 'Permite auto-cadastro público via link/convite no App/PWA', def: 1 },
      { key: 'members.approval_workflow', cat: 'Membros', desc: 'Exige aprovação da liderança para novos cadastros', def: 0 },
      { key: 'members.lgpd_export_consent', cat: 'Membros', desc: 'Termo de consentimento e anonimização/exportação LGPD', def: 1 },
      { key: 'members.spiritual_timeline', cat: 'Membros', desc: 'Registro de batismos, consagrações e marcos espirituais', def: 1 },
      { key: 'members.custom_fields', cat: 'Membros', desc: 'Criação de campos dinâmicos no perfil do membro', def: 0 },

      // Células & Redes
      { key: 'cell_groups.module_enabled', cat: 'Células', desc: 'Habilita o módulo de Células/Pequenos Grupos/GC', def: 1 },
      { key: 'cell_groups.public_map_locator', cat: 'Células', desc: 'Exibe busca de células por geolocalização e mapa no App/PWA', def: 1 },
      { key: 'cell_groups.attendance_reports', cat: 'Células', desc: 'Envio de relatórios semanais de reunião pelos líderes', def: 1 },
      { key: 'cell_groups.board_posts', cat: 'Células', desc: 'Mural interativo de avisos e testemunhos da célula', def: 1 },
      { key: 'cell_groups.snack_partilhas', cat: 'Células', desc: 'Gestão da lista de partilha de lanches e contribuições', def: 1 },
      { key: 'cell_groups.join_request_flow', cat: 'Células', desc: 'Fluxo de solicitação de entrada em célula pelo membro', def: 1 },

      // Ministério Infantil (Kids)
      { key: 'kids.module_enabled', cat: 'Kids', desc: 'Habilita o módulo do Ministério Infantil', def: 1 },
      { key: 'kids.live_rooms_dashboard', cat: 'Kids', desc: 'Painel ao vivo de salas por faixa etária e lotação', def: 1 },
      { key: 'kids.express_kiosk_checkin', cat: 'Kids', desc: 'Modo Totem de autoatendimento para pais com busca rápida', def: 1 },
      { key: 'kids.thermal_badge_printing', cat: 'Kids', desc: 'Geração e impressão de crachás térmicos com QR Code', def: 1 },
      { key: 'kids.emergency_parent_call', cat: 'Kids', desc: 'Central de chamados de pais no telão/WhatsApp durante o culto', def: 1 },
      { key: 'kids.allergy_medical_alerts', cat: 'Kids', desc: 'Gestão de alertas médicos, restrições e alergias', def: 1 },
      { key: 'kids.secure_checkout_validation', cat: 'Kids', desc: 'Validação de código de segurança na saída da criança', def: 1 },
      { key: 'kids.reports_export', cat: 'Kids', desc: 'Relatórios consolidados de frequência e demografia infantil', def: 1 },

      // Finanças & Tesouraria
      { key: 'financial.module_enabled', cat: 'Finanças', desc: 'Habilita o módulo financeiro e tesouraria', def: 1 },
      { key: 'financial.cashflow_ledger', cat: 'Finanças', desc: 'Livro caixa, lançamentos de entradas e saídas', def: 1 },
      { key: 'financial.dre_reports', cat: 'Finanças', desc: 'Demonstrativo de Resultados (DRE) e balancetes', def: 1 },
      { key: 'financial.special_projects', cat: 'Finanças', desc: 'Campanhas e projetos com metas e barras de progresso', def: 1 },
      { key: 'financial.online_pix_giving', cat: 'Finanças', desc: 'Contribuição online de dízimos/ofertas via PIX dinâmico', def: 1 },
      { key: 'financial.credit_card_gateway', cat: 'Finanças', desc: 'Pagamento via Cartão de Crédito com Pagar.me/Asaas', def: 1 },
      { key: 'financial.member_tax_statement', cat: 'Finanças', desc: 'Emissão de informe anual de contribuições para IRPF', def: 1 },

      // Eventos & Bilheteria
      { key: 'events.module_enabled', cat: 'Eventos', desc: 'Habilita o módulo de eventos', def: 1 },
      { key: 'events.paid_ticketing', cat: 'Eventos', desc: 'Venda de ingressos com múltiplos lotes e precificação', def: 1 },
      { key: 'events.gate_scanner_qrcode', cat: 'Eventos', desc: 'Validador de ingressos na portaria com câmera/scanner', def: 1 },
      { key: 'events.custom_forms', cat: 'Eventos', desc: 'Formulário de inscrição com perguntas personalizadas', def: 1 },

      // Ponto de Venda / Cantina / Loja
      { key: 'pdv.module_enabled', cat: 'PDV', desc: 'Habilita a cantina, livraria e ponto de venda', def: 1 },
      { key: 'pdv.stock_inventory', cat: 'PDV', desc: 'Controle de estoque de produtos e insumos', def: 1 },
      { key: 'pdv.order_kanban_monitor', cat: 'PDV', desc: 'Painel Kanban em tempo real para a cozinha/balcão', def: 1 },
      { key: 'pdv.mobile_inapp_ordering', cat: 'PDV', desc: 'Autoatendimento de pedidos pelo App/PWA dos membros', def: 1 },
      { key: 'pdv.counter_quick_sale', cat: 'PDV', desc: 'Frente de caixa rápida para operadores de balcão', def: 1 },
      { key: 'pdv.delivery_mode_home', cat: 'PDV', desc: 'Opção de entrega a domicílio além da retirada no local', def: 0 },

      // Devocionais
      { key: 'devotionals.module_enabled', cat: 'Devocionais', desc: 'Habilita os devocionais diários', def: 1 },
      { key: 'devotionals.worship_song_embed', cat: 'Devocionais', desc: 'Reprodução de louvor sugerido no YouTube integrado', def: 1 },
      { key: 'devotionals.member_private_notes', cat: 'Devocionais', desc: 'Caderno privado de notas do membro por devocional', def: 1 },

      // Estudos
      { key: 'studies.module_enabled', cat: 'Estudos', desc: 'Habilita os estudos bíblicos e trilhas', def: 1 },
      { key: 'studies.cell_targeted_content', cat: 'Estudos', desc: 'Restrição de estudos por grupo/célula específica', def: 1 },

      // Cultos & Lives
      { key: 'broadcasts.module_enabled', cat: 'Transmissões', desc: 'Habilita transmissões de cultos e lives', def: 1 },
      { key: 'broadcasts.inapp_live_alert', cat: 'Transmissões', desc: 'Banner flutuante no topo do App/PWA quando houver live', def: 1 },
      { key: 'broadcasts.interactive_chat', cat: 'Transmissões', desc: 'Chat ao vivo moderado durante o culto online', def: 0 },

      // Orações
      { key: 'prayers.module_enabled', cat: 'Orações', desc: 'Habilita o mural de oração e intercessão', def: 1 },
      { key: 'prayers.anonymous_allowed', cat: 'Orações', desc: 'Permite envio de pedidos de oração anônimos', def: 1 },
      { key: 'prayers.confidential_pastoral', cat: 'Orações', desc: 'Opção de pedido estritamente confidencial aos pastores', def: 1 },
      { key: 'prayers.intercession_counter', cat: 'Orações', desc: 'Botão "Estou Orando" com contador em tempo real', def: 1 },

      // Bíblia Digital
      { key: 'bible.module_enabled', cat: 'Bíblia', desc: 'Habilita a Bíblia Digital no App e PWA', def: 1 },
      { key: 'bible.version_switching', cat: 'Bíblia', desc: 'Permite ao membro alternar entre versões (NVI, ACF, AA)', def: 1 },
      { key: 'bible.daily_verse_card', cat: 'Bíblia', desc: 'Exibição do versículo do dia no feed inicial', def: 1 },
      { key: 'bible.social_share_card', cat: 'Bíblia', desc: 'Gerador de imagem com versículo para redes sociais', def: 1 },

      // Whitelabel & Multi-Campus
      { key: 'system.multicampus_enabled', cat: 'Sistema', desc: 'Habilita gestão de múltiplas unidades/filiais', def: 1 },
      { key: 'system.custom_domain', cat: 'Sistema', desc: 'Habilita roteamento por domínio próprio CNAME da igreja', def: 1 },
      { key: 'system.custom_theme_colors', cat: 'Sistema', desc: 'Customização de paleta de cores e logomarcas', def: 1 },
      { key: 'system.pwa_offline_sync', cat: 'Sistema', desc: 'Modo offline com sincronização em segundo plano no PWA', def: 1 },
      { key: 'system.saas_subscription_portal', cat: 'Sistema', desc: 'Visualização de faturas e planos pelo tenant no admin', def: 1 }
    ];

    // Inserir flags globais padrão
    for (const f of defaultFlags) {
      const flagId = `flag_global_${f.key.replace(/\./g, '_')}`;
      await connection.query(`
        INSERT INTO tenant_feature_flags (
          id, organization_id, campus_id, environment, feature_key, is_enabled, category, description, updated_by
        ) VALUES (?, 'global', NULL, 'all', ?, ?, ?, ?, 'System Migration')
        ON DUPLICATE KEY UPDATE
          category = VALUES(category),
          description = VALUES(description);
      `, [flagId, f.key, f.def, f.cat, f.desc]);
    }

    console.log(`✔ Inseridas/atualizadas ${defaultFlags.length} Feature Flags globais padrão.`);

    const [totalRows] = await connection.query('SELECT COUNT(*) as total FROM tenant_feature_flags');
    console.log(`🎉 Migração concluída! Total de flags no banco: ${totalRows[0].total}`);

  } catch (err) {
    console.error('❌ Erro na migração:', err);
  } finally {
    await connection.end();
  }
}

runFeatureFlagsMigration().catch(console.error);
