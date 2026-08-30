// Lambdas para Gestão de Propostas Comerciais, Funil SaaS e Assinaturas
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { query, apiResponse } from '../db';
import { AsaasService } from '../services/asaasService';
import { ProvisioningService } from '../services/provisioningService';
import { requireAuth, enforceRole } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';

// 1. Criar Nova Proposta Comercial (POST /proposals) - Apenas SuperAdmin
export const createProposal = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN']);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const {
      church_name,
      cnpj_cpf,
      contact_name,
      contact_email,
      contact_phone,
      plan_tier,
      billing_cycle,
      monthly_amount,
      setup_fee,
      suggested_slug,
      features_included,
      notes,
      expires_days,
      created_by,
      discount_type,
      discount_value,
      discount_duration_months,
      notes_commercial
    } = body;

    if (!church_name || !contact_name || !contact_email || !monthly_amount) {
      return apiResponse(400, { message: 'Campos obrigatórios faltando (church_name, contact_name, contact_email, monthly_amount)' });
    }

    const id = uuidv4();
    const token = crypto.randomBytes(24).toString('hex');
    const daysValid = Number(expires_days) || 15;
    const expiresAt = new Date(Date.now() + daysValid * 24 * 60 * 60 * 1000);

    const baseAmount = Number(monthly_amount);
    const discType = discount_type || 'NONE';
    const discVal = Number(discount_value || 0);
    const discMonths = Number(discount_duration_months || 0);

    let firstCycleAmount = baseAmount;
    if (discType === 'FIRST_FREE') {
      firstCycleAmount = 0.00;
    } else if (discType === 'FIRST_MONTH_DISCOUNT' || discType === 'RECURRING_MONTHS_DISCOUNT') {
      firstCycleAmount = Math.max(0, baseAmount - discVal);
    } else if (discType === 'PERMANENT_DISCOUNT') {
      firstCycleAmount = Math.max(0, baseAmount - discVal);
    }

    // 1. Cria cliente preliminar no Asaas (se configurado)
    let asaasCustomerId: string | null = null;
    try {
      const asaasCustomer = await AsaasService.createCustomer({
        name: contact_name,
        email: contact_email,
        cpfCnpj: cnpj_cpf,
        mobilePhone: contact_phone
      });
      asaasCustomerId = asaasCustomer.id || null;
    } catch (e) {
      console.warn('Asaas createCustomer silencioso:', e);
    }

    const defaultFeatures = [
      'Aplicativo PWA Mobile Whitelabel Personalizado',
      'Portal Administrativo Web Studio Multi-usuário',
      'Módulo Completo de Células & Redes (com Painel do Líder)',
      'Bíblia Sagrada Offline Integrada',
      'Cantina & Loja com PDV Mobile e Pagamentos PIX',
      'Central de Transmissões e Cultos ao Vivo',
      'Emissão de Ingressos com Scanner QR Code para Eventos',
      'Hospedagem e Infraestrutura Serverless na AWS inclusa',
      'Suporte Técnico Dedicado'
    ];

    const featuresJson = JSON.stringify(Array.isArray(features_included) ? features_included : defaultFeatures);

    const q = `
      INSERT INTO saas_proposals (
        id, token, church_name, cnpj_cpf, contact_name, contact_email, contact_phone,
        plan_tier, billing_cycle, monthly_amount, setup_fee, suggested_slug,
        status, features_included, notes, expires_at, asaas_customer_id, created_by,
        discount_type, discount_value, discount_duration_months, first_cycle_amount, notes_commercial
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await query(q, [
      id,
      token,
      church_name,
      cnpj_cpf || null,
      contact_name,
      contact_email,
      contact_phone || null,
      plan_tier || 'PRO',
      billing_cycle || 'MONTHLY',
      baseAmount,
      Number(setup_fee || 0),
      suggested_slug || null,
      featuresJson,
      notes || null,
      expiresAt,
      asaasCustomerId,
      created_by || 'Master Admin',
      discType,
      discVal,
      discMonths,
      firstCycleAmount,
      notes_commercial || null
    ]);

    const proposalUrl = `https://studio.faithhubs.com/?proposta=${token}`;

    return apiResponse(201, {
      message: 'Proposta comercial gerada com sucesso!',
      proposal: {
        id,
        token,
        church_name,
        contact_name,
        contact_email,
        contact_phone,
        plan_tier: plan_tier || 'PRO',
        billing_cycle: billing_cycle || 'MONTHLY',
        monthly_amount: baseAmount,
        discount_type: discType,
        discount_value: discVal,
        discount_duration_months: discMonths,
        first_cycle_amount: firstCycleAmount,
        notes_commercial,
        setup_fee: Number(setup_fee || 0),
        status: 'SENT',
        proposal_url: proposalUrl,
        expires_at: expiresAt
      }
    });
  } catch (error: any) {
    console.error('Erro ao criar proposta:', error);
    return apiResponse(500, { message: 'Erro ao gerar proposta comercial', error: error.message });
  }
};

// 2. Listar Propostas e Métricas do Funil (GET /proposals) - Apenas SuperAdmin
export const listProposals = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN']);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const { rows: proposals } = await query(`
      SELECT * FROM saas_proposals 
      ORDER BY created_at DESC
    `);

    let totalMRR = 0;
    let pipelineMRR = 0;
    const funnel = {
      total: proposals.length,
      draft: 0,
      sent: 0,
      viewed: 0,
      accepted: 0,
      paid: 0,
      cancelled: 0
    };

    proposals.forEach((p: any) => {
      const amount = Number(p.monthly_amount) || 0;
      const status = (p.status || '').toUpperCase();

      if (status === 'DRAFT') funnel.draft++;
      else if (status === 'SENT') { funnel.sent++; pipelineMRR += amount; }
      else if (status === 'VIEWED') { funnel.viewed++; pipelineMRR += amount; }
      else if (status === 'ACCEPTED') { funnel.accepted++; pipelineMRR += amount; }
      else if (status === 'PAID') { funnel.paid++; totalMRR += amount; }
      else if (status === 'CANCELLED' || status === 'EXPIRED') funnel.cancelled++;

      p.proposal_url = `https://studio.faithhubs.com/?proposta=${p.token}`;
      try {
        p.features_included = typeof p.features_included === 'string' ? JSON.parse(p.features_included || '[]') : p.features_included;
      } catch {
        p.features_included = [];
      }
    });

    return apiResponse(200, {
      stats: {
        total_proposals: proposals.length,
        active_mrr: totalMRR,
        pipeline_mrr: pipelineMRR,
        conversion_rate: proposals.length > 0 ? Math.round((funnel.paid / proposals.length) * 100) : 0,
        funnel
      },
      proposals
    });
  } catch (error: any) {
    console.error('Erro ao listar propostas:', error);
    return apiResponse(500, { message: 'Erro ao buscar propostas', error: error.message });
  }
};

// 3. Obter Proposta Pública pelo Token (GET /proposals/public/{token})
export const getPublicProposal = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const token = event.pathParameters?.token || event.queryStringParameters?.token;
    if (!token) return apiResponse(400, { message: 'Token de proposta ausente' });

    const { rows } = await query(`SELECT * FROM saas_proposals WHERE token = ? OR id = ? LIMIT 1`, [token, token]);
    if (rows.length === 0) {
      return apiResponse(404, { message: 'Proposta comercial não encontrada ou expirada' });
    }

    const proposal = rows[0];

    // Se o status era SENT, marca como VIEWED (Pastor abriu a proposta!)
    if (proposal.status === 'SENT') {
      await query(`UPDATE saas_proposals SET status = 'VIEWED', updated_at = NOW() WHERE id = ?`, [proposal.id]);
      proposal.status = 'VIEWED';
    }

    try {
      proposal.features_included = typeof proposal.features_included === 'string' ? JSON.parse(proposal.features_included || '[]') : proposal.features_included;
    } catch {
      proposal.features_included = [];
    }

    return apiResponse(200, proposal);
  } catch (error: any) {
    console.error('Erro ao buscar proposta pública:', error);
    return apiResponse(500, { message: 'Erro ao carregar proposta', error: error.message });
  }
};

// 4. Aceitar Proposta e Gerar Checkout / Ativação (POST /proposals/public/{token}/accept)
export const acceptProposal = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const token = event.pathParameters?.token || event.queryStringParameters?.token;
    const body = JSON.parse(event.body || '{}');
    const clientIp = event.requestContext?.identity?.sourceIp || 'web_client';

    if (!token) return apiResponse(400, { message: 'Token de proposta ausente' });

    const { rows } = await query(`SELECT * FROM saas_proposals WHERE token = ? OR id = ? LIMIT 1`, [token, token]);
    if (rows.length === 0) {
      return apiResponse(404, { message: 'Proposta não encontrada' });
    }

    const proposal = rows[0];

    // Se já foi paga / provisionada
    if (proposal.status === 'PAID') {
      return apiResponse(200, {
        message: 'Esta proposta já foi aprovada e o ambiente está ativo!',
        status: 'PAID',
        organization_id: proposal.created_organization_id
      });
    }

    const isFirstFree = proposal.discount_type === 'FIRST_FREE';
    let asaasSubId = proposal.asaas_subscription_id;
    let paymentLink = proposal.asaas_payment_link;

    try {
      let customerId = proposal.asaas_customer_id;
      if (!customerId) {
        const customer = await AsaasService.createCustomer({
          name: proposal.contact_name,
          email: proposal.contact_email,
          cpfCnpj: proposal.cnpj_cpf,
          mobilePhone: proposal.contact_phone
        });
        customerId = customer.id;
      }

      // Se a primeira mensalidade for gratuita (carência de 30 dias), agenda para 30 dias à frente
      const daysAhead = isFirstFree ? 30 : 2;
      const dueDate = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      // Cria assinatura recorrente no Asaas
      const sub = await AsaasService.createSubscription({
        customer: customerId,
        billingType: body.billingType || 'PIX',
        value: Number(proposal.monthly_amount),
        nextDueDate: dueDate,
        cycle: proposal.billing_cycle === 'YEARLY' ? 'YEARLY' : 'MONTHLY',
        description: `Assinatura Faith-Hub SaaS - ${proposal.church_name} (${proposal.plan_tier})${isFirstFree ? ' [1º Mês Grátis]' : ''}`,
        creditCard: body.creditCard,
        creditCardHolderInfo: body.creditCardHolderInfo
      });

      asaasSubId = sub.id;
      paymentLink = sub.paymentLink || sub.invoiceUrl || `https://studio.faithhubs.com/?proposta=${token}&step=pay`;
    } catch (asaasErr) {
      console.warn('Erro ao criar assinatura Asaas:', asaasErr);
    }

    // Se a primeira mensalidade é 100% gratuita, PROVISIONA O AMBIENTE IMEDIATAMENTE NA AWS!
    if (isFirstFree) {
      console.log(`🎁 Proposta com 1º mês grátis aceita. Provisionando ambiente imediatamente: ${proposal.id}`);
      const provisionResult = await ProvisioningService.provisionFromProposal(proposal.id);

      await query(`
        UPDATE saas_proposals 
        SET status = 'PAID',
            accepted_at = NOW(),
            accepted_ip = ?,
            asaas_subscription_id = ?,
            asaas_payment_link = ?,
            updated_at = NOW()
        WHERE id = ?
      `, [clientIp, asaasSubId, paymentLink, proposal.id]);

      return apiResponse(200, {
        message: '🎉 Parabéns! Sua proposta com 1º Mês Grátis foi ativada e o ambiente já está pronto!',
        status: 'PAID',
        is_free_trial: true,
        provision_result: provisionResult,
        login_url: 'https://studio.faithhubs.com',
        pwa_url: provisionResult.pwa_url
      });
    }

    // Caso contrário, atualiza como ACCEPTED e aguarda pagamento da primeira mensalidade
    await query(`
      UPDATE saas_proposals 
      SET status = 'ACCEPTED',
          accepted_at = NOW(),
          accepted_ip = ?,
          asaas_subscription_id = ?,
          asaas_payment_link = ?,
          updated_at = NOW()
      WHERE id = ?
    `, [clientIp, asaasSubId, paymentLink, proposal.id]);

    return apiResponse(200, {
      message: 'Proposta aceita com sucesso!',
      proposal_id: proposal.id,
      status: 'ACCEPTED',
      payment_link: paymentLink,
      subscription_id: asaasSubId
    });
  } catch (error: any) {
    console.error('Erro ao aceitar proposta:', error);
    return apiResponse(500, { message: 'Erro ao aceitar proposta comercial', error: error.message });
  }
};

// 5. Simular Pagamento e Testar Provisionamento Instantâneo (POST /proposals/{id}/simulate-payment)
export const simulatePayment = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID da proposta ausente' });

    console.log(`⚡ Simulando pagamento e disparando provisionamento da proposta: ${id}`);
    const result = await ProvisioningService.provisionFromProposal(id);

    return apiResponse(200, {
      message: 'Pagamento confirmado e Ambiente provisionado com sucesso!',
      result
    });
  } catch (error: any) {
    console.error('Erro ao simular pagamento:', error);
    return apiResponse(500, { message: 'Erro no provisionamento automático', error: error.message });
  }
};

// 6. Listar Assinaturas do SaaS (GET /saas-subscriptions)
export const listSubscriptions = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const { rows } = await query(`
      SELECT s.*, o.name as church_name
      FROM saas_subscriptions s
      LEFT JOIN organizations o ON s.organization_id = o.id
      ORDER BY s.created_at DESC
    `);
    return apiResponse(200, rows);
  } catch (error: any) {
    console.error('Erro ao listar assinaturas:', error);
    return apiResponse(500, { message: 'Erro ao buscar assinaturas', error: error.message });
  }
};
