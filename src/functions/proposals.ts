// Lambdas para Gestão de Propostas Comerciais, Funil SaaS e Assinaturas
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { query, apiResponse } from '../db';
import { AsaasService } from '../services/asaasService';
import { ProvisioningService } from '../services/provisioningService';

// 1. Criar Nova Proposta Comercial (POST /proposals)
export const createProposal = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
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
      created_by
    } = body;

    if (!church_name || !contact_name || !contact_email || !monthly_amount) {
      return apiResponse(400, { message: 'Campos obrigatórios faltando (church_name, contact_name, contact_email, monthly_amount)' });
    }

    const id = uuidv4();
    const token = crypto.randomBytes(24).toString('hex');
    const daysValid = Number(expires_days) || 15;
    const expiresAt = new Date(Date.now() + daysValid * 24 * 60 * 60 * 1000);

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
        status, features_included, notes, expires_at, asaas_customer_id, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, ?, ?, ?, ?)
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
      Number(monthly_amount),
      Number(setup_fee || 0),
      suggested_slug || null,
      featuresJson,
      notes || null,
      expiresAt,
      asaasCustomerId,
      created_by || 'Master Admin'
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
        monthly_amount: Number(monthly_amount),
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

// 2. Listar Propostas e Métricas do Funil (GET /proposals)
export const listProposals = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const { rows: proposals } = await query(`
      SELECT * FROM saas_proposals 
      ORDER BY created_at DESC
    `);

    // Calcula Métricas Consolidadas do Funil
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

      // Formata link da proposta
      p.proposal_url = `https://studio.faithhubs.com/?proposta=${p.token}`;
      try {
        p.features_included = JSON.parse(p.features_included || '[]');
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
      proposal.features_included = JSON.parse(proposal.features_included || '[]');
    } catch {
      proposal.features_included = [];
    }

    return apiResponse(200, proposal);
  } catch (error: any) {
    console.error('Erro ao buscar proposta pública:', error);
    return apiResponse(500, { message: 'Erro ao carregar proposta', error: error.message });
  }
};

// 4. Aceitar Proposta e Gerar Checkout Asaas (POST /proposals/public/{token}/accept)
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

    // Se já foi paga
    if (proposal.status === 'PAID') {
      return apiResponse(200, {
        message: 'Esta proposta já foi aprovada e o ambiente está ativo!',
        status: 'PAID',
        organization_id: proposal.created_organization_id
      });
    }

    // 1. Cria Assinatura no Asaas
    let asaasSubId = proposal.asaas_subscription_id;
    let paymentLink = proposal.asaas_payment_link;

    try {
      // Garante que o cliente existe no Asaas
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

      // Cria assinatura recorrente
      const sub = await AsaasService.createSubscription({
        customer: customerId,
        billingType: body.billingType || 'PIX',
        value: Number(proposal.monthly_amount),
        nextDueDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        cycle: proposal.billing_cycle === 'YEARLY' ? 'YEARLY' : 'MONTHLY',
        description: `Assinatura Faith-Hub SaaS - ${proposal.church_name} (${proposal.plan_tier})`,
        creditCard: body.creditCard,
        creditCardHolderInfo: body.creditCardHolderInfo
      });

      asaasSubId = sub.id;
      paymentLink = sub.paymentLink || sub.invoiceUrl || `https://studio.faithhubs.com/?proposta=${token}&step=pay`;
    } catch (asaasErr) {
      console.warn('Erro ao criar assinatura Asaas (usando fallback):', asaasErr);
    }

    // 2. Atualiza Proposta com Aceite
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

// 6. Listar Assinaturas Ativas (GET /saas-subscriptions)
export const listSubscriptions = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const { rows } = await query(`
      SELECT s.*, o.name as org_name, o.slug as org_slug, o.plan as org_plan 
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
