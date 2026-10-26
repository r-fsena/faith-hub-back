import { checkRateLimit } from '../services/rateLimiter';
// Lambdas para Gestão de Propostas Comerciais, Funil SaaS e Assinaturas
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { query, apiResponse, getConnection } from '../db';
import { AsaasService } from '../services/asaasService';
import { requireAuth, enforceRole, enforceTenant } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';
import { evaluateSaasCheckoutAccess } from '../services/featureFlagService';

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
      null,
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
      else if (status === 'PAID') {
        funnel.paid++;
        if (p.billing_status !== 'LEGACY_UNVERIFIED') totalMRR += amount;
      }
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

    const { rows } = await query(`SELECT
      id, token, church_name, suggested_slug, contact_name, contact_email, contact_phone,
      plan_tier, billing_cycle, monthly_amount, setup_fee, status, features_included,
      notes, expires_at, accepted_at, created_organization_id, asaas_checkout_url,
      discount_type, discount_value, discount_duration_months, first_cycle_amount,
      notes_commercial, billing_status
      FROM saas_proposals WHERE token = ? LIMIT 1`, [token]);
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
    proposal.checkout_available = await evaluateSaasCheckoutAccess(proposal.id);

    return apiResponse(200, proposal);
  } catch (error: any) {
    console.error('Erro ao buscar proposta pública:', error);
    return apiResponse(500, { message: 'Erro ao carregar proposta', error: error.message });
  }
};

// 4. Aceitar Proposta e Gerar Checkout / Ativação (POST /proposals/public/{token}/accept)
export const acceptProposal = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let connection: Awaited<ReturnType<typeof getConnection>> | undefined;
  try {
    const limit = await checkRateLimit(event, { maxRequests: 10, windowSeconds: 60, identifierPrefix: 'accept-proposal' });
    if (!limit.allowed) return limit.errorResponse!;
    const token = event.pathParameters?.token || event.queryStringParameters?.token;
    const body = JSON.parse(event.body || '{}');
    const clientIp = (event.requestContext as any)?.http?.sourceIp || event.requestContext?.identity?.sourceIp || 'web_client';

    if (!token) return apiResponse(400, { message: 'Token de proposta ausente' });
    if (body.creditCard || body.creditCardHolderInfo) {
      return apiResponse(400, { message: 'Dados de cartão devem ser informados somente no checkout seguro do Asaas.' });
    }
    if (body.termsAccepted !== true) return apiResponse(400, { message: 'É necessário aceitar os termos da proposta.' });

    connection = await getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.query(`SELECT * FROM saas_proposals WHERE token = ? LIMIT 1 FOR UPDATE`, [token]) as any;
    if (rows.length === 0) {
      await connection.rollback();
      return apiResponse(404, { message: 'Proposta não encontrada' });
    }

    const proposal = rows[0];
    if (!(await evaluateSaasCheckoutAccess(proposal.id))) {
      await connection.rollback();
      return apiResponse(503, { message: 'Checkout temporariamente indisponível para esta proposta.' });
    }
    if (proposal.expires_at && new Date(proposal.expires_at) < new Date()) {
      await connection.rollback();
      return apiResponse(410, { message: 'Proposta expirada' });
    }
    if (proposal.status === 'PAID') {
      await connection.commit();
      return apiResponse(200, {
        message: 'Esta proposta já foi aprovada e o ambiente está ativo!',
        status: 'PAID',
        organization_id: proposal.created_organization_id
      });
    }
    if (proposal.asaas_checkout_id && proposal.asaas_checkout_url) {
      await connection.commit();
      return apiResponse(200, {
        message: 'Checkout já criado.', status: 'ACCEPTED',
        checkout_id: proposal.asaas_checkout_id, payment_link: proposal.asaas_checkout_url
      });
    }
    if (!proposal.cnpj_cpf) {
      await connection.rollback();
      return apiResponse(422, { message: 'A proposta precisa de CPF/CNPJ para iniciar o checkout.' });
    }
    if (Number(proposal.setup_fee || 0) > 0 || ['FIRST_MONTH_DISCOUNT', 'RECURRING_MONTHS_DISCOUNT'].includes(proposal.discount_type)) {
      await connection.rollback();
      return apiResponse(409, {
        message: 'Esta condição comercial precisa ser convertida em cobrança compatível antes do checkout recorrente.'
      });
    }

    const externalReference = `faithhub:proposal:${proposal.id}`;
    const isFirstFree = proposal.discount_type === 'FIRST_FREE';
    const recurringValue = proposal.discount_type === 'PERMANENT_DISCOUNT'
      ? Number(proposal.first_cycle_amount)
      : Number(proposal.monthly_amount);
    if (!Number.isFinite(recurringValue) || recurringValue < 5) {
      await connection.rollback();
      return apiResponse(409, { message: 'O valor recorrente mínimo aceito pelo Asaas é R$ 5,00.' });
    }
    const daysAhead = isFirstFree ? 30 : 0;
    const nextDueDate = new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
    const checkout = await AsaasService.createHostedRecurringCheckout({
      externalReference,
      billingTypes: ['CREDIT_CARD'],
      name: `Faith-Hub ${proposal.plan_tier}`,
      description: `Assinatura recorrente Faith-Hub para ${proposal.church_name}`,
      value: recurringValue,
      cycle: proposal.billing_cycle === 'YEARLY' ? 'YEARLY' :
        proposal.billing_cycle === 'SEMIANNUAL' ? 'SEMIANNUALLY' :
        proposal.billing_cycle === 'QUARTERLY' ? 'QUARTERLY' : 'MONTHLY',
      nextDueDate,
      successUrl: `https://studio.faithhubs.com/?proposta=${encodeURIComponent(token)}&retorno=asaas-sucesso`,
      cancelUrl: `https://studio.faithhubs.com/?proposta=${encodeURIComponent(token)}&retorno=asaas-cancelado`,
      expiredUrl: `https://studio.faithhubs.com/?proposta=${encodeURIComponent(token)}&retorno=asaas-expirado`
    });

    await connection.query(`UPDATE saas_proposals
      SET status = 'ACCEPTED',
          accepted_at = NOW(),
          accepted_ip = ?,
          asaas_checkout_id = ?,
          asaas_checkout_url = ?,
          asaas_payment_link = ?,
          billing_status = 'CHECKOUT_CREATED',
          billing_external_reference = ?,
          billing_environment = ?,
          billing_error = NULL,
          updated_at = NOW()
      WHERE id = ?
    `, [clientIp, checkout.id, checkout.url, checkout.url, externalReference, checkout.environment, proposal.id]);
    await connection.commit();

    await logSecurityEvent({
      organizationId: proposal.created_organization_id || 'org_default',
      action: 'CREATE_ASAAS_HOSTED_CHECKOUT',
      resource: 'saas_proposals',
      resourceId: proposal.id,
      details: { checkoutId: checkout.id, billingTypes: ['CREDIT_CARD'], environment: checkout.environment },
      event
    });

    return apiResponse(200, {
      message: 'Checkout seguro criado com sucesso.',
      proposal_id: proposal.id,
      status: 'ACCEPTED',
      checkout_id: checkout.id,
      payment_link: checkout.url
    });
  } catch (error: any) {
    if (connection) await connection.rollback().catch(() => undefined);
    console.error('Erro ao criar checkout hospedado:', {
      error: error?.message || 'UNKNOWN',
      providerErrors: error?.providerErrors || []
    });
    return apiResponse(502, { message: 'Não foi possível iniciar o checkout seguro. Tente novamente.' });
  } finally {
    connection?.release();
  }
};

// 5. Listar Assinaturas do SaaS (GET /saas-subscriptions) - SUPERADMIN ou ADMIN com isolamento de tenant
export const listSubscriptions = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN', 'ADMIN']);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const requestedOrgId = event.queryStringParameters?.organization_id;
    const tenantCheck = enforceTenant(auth.user, requestedOrgId);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    const targetOrgId = requestedOrgId || (!auth.user.isSuperAdmin ? auth.user.organizationId : null);

    let sql = `
      SELECT
        s.id,
        s.organization_id,
        COALESCE(s.church_name, o.name) as church_name,
        o.plan as org_plan,
        COALESCE(p.name, o.plan, 'Pro') as plan_name,
        p.description as plan_description,
        p.badge_text as plan_badge,
        s.value, s.cycle, s.billing_type, s.next_due_date, s.status,
        s.provider_status, s.external_reference, s.is_verified,
        p.features as plan_features,
        p.max_members,
        p.max_campuses,
        s.created_at,
        s.updated_at
      FROM saas_subscriptions s
      LEFT JOIN organizations o ON o.id = s.organization_id
      LEFT JOIN saas_plans p ON p.id = o.plan
    `;
    const params: any[] = [];

    if (targetOrgId) {
      sql += ` WHERE s.organization_id = ?`;
      params.push(targetOrgId);
    }

    sql += ` ORDER BY s.created_at DESC`;

    const { rows } = await query(sql, params);
    return apiResponse(200, rows);
  } catch (error: any) {
    console.error('Erro ao listar assinaturas:', error);
    return apiResponse(500, { message: 'Erro ao buscar assinaturas', error: error.message });
  }
};
