import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth, enforceRole, enforceTenant } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';

const FINANCIAL_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'TREASURER'];

// ==========================================
// 1. TRANSAÇÕES FINANCEIRAS (DÍZIMOS, OFERTAS, DESPESAS, PDV)
// ==========================================

export const listFinancialTransactions = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, FINANCIAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const requestedOrgId = event.queryStringParameters?.organization_id;
    const tenantCheck = enforceTenant(auth.user, requestedOrgId);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    const orgId = tenantCheck.effectiveOrgId;
    const campusId = event.queryStringParameters?.campus_id;
    const type = event.queryStringParameters?.type; // INCOME / EXPENSE
    const category = event.queryStringParameters?.category;
    const status = event.queryStringParameters?.status;
    const startDate = event.queryStringParameters?.start_date;
    const endDate = event.queryStringParameters?.end_date;
    const search = event.queryStringParameters?.search;

    let sql = `
      SELECT t.*,
             c.name as campus_name,
             p.title as project_title
      FROM church_financial_transactions t
      LEFT JOIN campuses c ON c.id = t.campus_id
      LEFT JOIN church_special_projects p ON p.id = t.project_id
      WHERE t.organization_id = ?
    `;
    const params: any[] = [orgId];

    if (campusId && campusId !== 'all') {
      sql += ` AND (t.campus_id = ? OR t.campus_id IS NULL)`;
      params.push(campusId);
    }

    if (type) {
      sql += ` AND t.type = ?`;
      params.push(type);
    }

    if (category) {
      sql += ` AND t.category = ?`;
      params.push(category);
    }

    if (status) {
      sql += ` AND t.status = ?`;
      params.push(status);
    }

    if (startDate) {
      sql += ` AND t.payment_date >= ?`;
      params.push(startDate);
    }

    if (endDate) {
      sql += ` AND t.payment_date <= ?`;
      params.push(endDate);
    }

    if (search) {
      sql += ` AND (t.description LIKE ? OR t.member_name LIKE ? OR t.category LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ` ORDER BY t.payment_date DESC, t.created_at DESC LIMIT 300`;

    const { rows } = await query(sql, params);
    return apiResponse(200, { data: rows });
  } catch (error: any) {
    console.error('Erro ao listar transações financeiras:', error);
    return apiResponse(500, { error: 'Erro ao processar consulta financeira' });
  }
};

export const createFinancialTransaction = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, FINANCIAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const {
      organization_id,
      campus_id,
      type,
      category,
      description,
      amount,
      payment_method,
      status,
      member_id,
      member_name,
      project_id,
      origin_module,
      receipt_url,
      due_date,
      payment_date
    } = body;

    const tenantCheck = enforceTenant(auth.user, organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgId = tenantCheck.effectiveOrgId;

    if (!type || !category || !description || amount === undefined) {
      return apiResponse(400, { error: 'Campos obrigatórios: type, category, description, amount' });
    }

    const id = uuidv4();
    const payDate = payment_date || new Date().toISOString().split('T')[0];
    const transStatus = status || 'PAID';
    const payMethod = payment_method || 'PIX';
    const origin = origin_module || 'MANUAL';

    await query(`
      INSERT INTO church_financial_transactions
      (id, organization_id, campus_id, type, category, description, amount, payment_method, status, member_id, member_name, project_id, origin_module, receipt_url, due_date, payment_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      orgId,
      campus_id || null,
      type,
      category,
      description,
      parseFloat(amount),
      payMethod,
      transStatus,
      member_id || null,
      member_name || null,
      project_id || null,
      origin,
      receipt_url || null,
      due_date || null,
      payDate,
      auth.user.name || auth.user.email
    ]);

    if (type === 'INCOME' && project_id && transStatus === 'PAID') {
      await query(`
        UPDATE church_special_projects
        SET collected_amount = collected_amount + ?
        WHERE id = ?
      `, [parseFloat(amount), project_id]);
    }

    await logSecurityEvent({
      organizationId: orgId,
      user: auth.user,
      action: 'CREATE_FINANCIAL_TRANSACTION',
      resource: 'church_financial_transactions',
      resourceId: id,
      details: { type, category, amount: parseFloat(amount), description },
      event
    });

    return apiResponse(201, { message: 'Transação registrada com sucesso!', id });
  } catch (error: any) {
    console.error('Erro ao registrar transação financeira:', error);
    return apiResponse(500, { error: 'Erro ao salvar transação financeira' });
  }
};

export const updateFinancialTransaction = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, FINANCIAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID da transação obrigatório' });

    // Ensure transaction belongs to user's organization
    const { rows: existingRows } = await query(`SELECT organization_id FROM church_financial_transactions WHERE id = ? LIMIT 1`, [id]);
    if (existingRows.length === 0) {
      return apiResponse(404, { error: 'Transação não encontrada' });
    }

    const tenantCheck = enforceTenant(auth.user, existingRows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const {
      type,
      category,
      description,
      amount,
      payment_method,
      status,
      member_name,
      project_id,
      receipt_url,
      payment_date
    } = body;

    await query(`
      UPDATE church_financial_transactions
      SET type = COALESCE(?, type),
          category = COALESCE(?, category),
          description = COALESCE(?, description),
          amount = COALESCE(?, amount),
          payment_method = COALESCE(?, payment_method),
          status = COALESCE(?, status),
          member_name = COALESCE(?, member_name),
          project_id = COALESCE(?, project_id),
          receipt_url = COALESCE(?, receipt_url),
          payment_date = COALESCE(?, payment_date)
      WHERE id = ?
    `, [
      type,
      category,
      description,
      amount !== undefined ? parseFloat(amount) : null,
      payment_method,
      status,
      member_name,
      project_id,
      receipt_url,
      payment_date,
      id
    ]);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'UPDATE_FINANCIAL_TRANSACTION',
      resource: 'church_financial_transactions',
      resourceId: id,
      details: { amount, description, status },
      event
    });

    return apiResponse(200, { message: 'Transação atualizada com sucesso!' });
  } catch (error: any) {
    console.error('Erro ao atualizar transação financeira:', error);
    return apiResponse(500, { error: 'Erro ao atualizar transação financeira' });
  }
};

export const deleteFinancialTransaction = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, FINANCIAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID da transação obrigatório' });

    const { rows: existingRows } = await query(`SELECT organization_id, amount, description FROM church_financial_transactions WHERE id = ? LIMIT 1`, [id]);
    if (existingRows.length === 0) {
      return apiResponse(404, { error: 'Transação não encontrada' });
    }

    const tenantCheck = enforceTenant(auth.user, existingRows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    await query(`DELETE FROM church_financial_transactions WHERE id = ?`, [id]);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'DELETE_FINANCIAL_TRANSACTION',
      resource: 'church_financial_transactions',
      resourceId: id,
      details: { amount: existingRows[0].amount, description: existingRows[0].description },
      event
    });

    return apiResponse(200, { message: 'Transação removida com sucesso!' });
  } catch (error: any) {
    console.error('Erro ao remover transação financeira:', error);
    return apiResponse(500, { error: 'Erro ao remover transação' });
  }
};

// ==========================================
// 2. RESUMO FINANCEIRO & DRE
// ==========================================

export const getFinancialSummary = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, FINANCIAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const requestedOrgId = event.queryStringParameters?.organization_id;
    const tenantCheck = enforceTenant(auth.user, requestedOrgId);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    const orgId = tenantCheck.effectiveOrgId;
    const campusId = event.queryStringParameters?.campus_id;
    const startDate = event.queryStringParameters?.start_date;
    const endDate = event.queryStringParameters?.end_date;

    let campusFilter = '';
    const params: any[] = [orgId];
    if (campusId && campusId !== 'all') {
      campusFilter = ' AND (campus_id = ? OR campus_id IS NULL)';
      params.push(campusId);
    }

    let dateFilter = '';
    if (startDate && endDate) {
      dateFilter = ' AND payment_date BETWEEN ? AND ?';
      params.push(startDate, endDate);
    }

    // Totais Gerais
    const { rows: totals } = await query(`
      SELECT
        SUM(CASE WHEN type = 'INCOME' AND status = 'PAID' THEN amount ELSE 0 END) as total_income,
        SUM(CASE WHEN type = 'EXPENSE' AND status = 'PAID' THEN amount ELSE 0 END) as total_expense,
        SUM(CASE WHEN type = 'INCOME' AND status = 'PENDING' THEN amount ELSE 0 END) as pending_income,
        SUM(CASE WHEN type = 'EXPENSE' AND status = 'PENDING' THEN amount ELSE 0 END) as pending_expense,
        COUNT(id) as total_transactions
      FROM church_financial_transactions
      WHERE organization_id = ? ${campusFilter} ${dateFilter}
    `, params);

    // Entradas por Categoria
    const { rows: incomeCategories } = await query(`
      SELECT category, SUM(amount) as total, COUNT(id) as count
      FROM church_financial_transactions
      WHERE organization_id = ? AND type = 'INCOME' AND status = 'PAID' ${campusFilter} ${dateFilter}
      GROUP BY category
      ORDER BY total DESC
    `, params);

    // Saídas por Categoria
    const { rows: expenseCategories } = await query(`
      SELECT category, SUM(amount) as total, COUNT(id) as count
      FROM church_financial_transactions
      WHERE organization_id = ? AND type = 'EXPENSE' AND status = 'PAID' ${campusFilter} ${dateFilter}
      GROUP BY category
      ORDER BY total DESC
    `, params);

    // Entradas por Módulo
    const { rows: byOrigin } = await query(`
      SELECT origin_module, SUM(amount) as total
      FROM church_financial_transactions
      WHERE organization_id = ? AND type = 'INCOME' AND status = 'PAID' ${campusFilter} ${dateFilter}
      GROUP BY origin_module
    `, params);

    const summary = totals[0] || {
      total_income: 0,
      total_expense: 0,
      pending_income: 0,
      pending_expense: 0,
      total_transactions: 0
    };

    const netBalance = (Number(summary.total_income) || 0) - (Number(summary.total_expense) || 0);

    return apiResponse(200, {
      summary: {
        total_income: Number(summary.total_income) || 0,
        total_expense: Number(summary.total_expense) || 0,
        pending_income: Number(summary.pending_income) || 0,
        pending_expense: Number(summary.pending_expense) || 0,
        net_balance: netBalance,
        total_transactions: Number(summary.total_transactions) || 0
      },
      income_by_category: incomeCategories,
      expense_by_category: expenseCategories,
      by_origin: byOrigin
    });
  } catch (error: any) {
    console.error('Erro ao obter resumo financeiro:', error);
    return apiResponse(500, { error: 'Erro ao gerar resumo financeiro' });
  }
};

// ==========================================
// 3. PROJETOS ESPECIAIS & CAMPANHAS DE ARRECADAÇÃO
// ==========================================

export const listSpecialProjects = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const requestedOrgId = event.queryStringParameters?.organization_id;
    const tenantCheck = enforceTenant(auth.user, requestedOrgId);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    const orgId = tenantCheck.effectiveOrgId;
    const campusId = event.queryStringParameters?.campus_id;
    const status = event.queryStringParameters?.status;

    let sql = `SELECT * FROM church_special_projects WHERE organization_id = ?`;
    const params: any[] = [orgId];

    if (campusId && campusId !== 'all') {
      sql += ` AND (campus_id = ? OR campus_id IS NULL)`;
      params.push(campusId);
    }

    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY created_at DESC`;

    const { rows } = await query(sql, params);
    return apiResponse(200, { data: rows });
  } catch (error: any) {
    console.error('Erro ao listar projetos especiais:', error);
    return apiResponse(500, { error: 'Erro ao listar projetos' });
  }
};

export const createOrUpdateSpecialProject = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, FINANCIAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const {
      id,
      organization_id,
      campus_id,
      title,
      description,
      image_url,
      target_amount,
      collected_amount,
      start_date,
      end_date,
      pix_key,
      status
    } = body;

    const tenantCheck = enforceTenant(auth.user, organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgId = tenantCheck.effectiveOrgId;

    if (!title || target_amount === undefined || !start_date) {
      return apiResponse(400, { error: 'Campos obrigatórios: title, target_amount, start_date' });
    }

    const projectId = id || uuidv4();

    await query(`
      INSERT INTO church_special_projects
      (id, organization_id, campus_id, title, description, image_url, target_amount, collected_amount, start_date, end_date, pix_key, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        title = VALUES(title),
        description = VALUES(description),
        image_url = VALUES(image_url),
        target_amount = VALUES(target_amount),
        collected_amount = VALUES(collected_amount),
        start_date = VALUES(start_date),
        end_date = VALUES(end_date),
        pix_key = VALUES(pix_key),
        status = VALUES(status),
        updated_at = NOW()
    `, [
      projectId,
      orgId,
      campus_id || null,
      title,
      description || null,
      image_url || null,
      parseFloat(target_amount),
      collected_amount !== undefined ? parseFloat(collected_amount) : 0.00,
      start_date,
      end_date || null,
      pix_key || null,
      status || 'ACTIVE'
    ]);

    return apiResponse(200, { message: 'Projeto salvo com sucesso!', id: projectId });
  } catch (error: any) {
    console.error('Erro ao salvar projeto especial:', error);
    return apiResponse(500, { error: 'Erro ao salvar projeto' });
  }
};

export const deleteSpecialProject = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, FINANCIAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID do projeto obrigatório' });

    const { rows } = await query(`SELECT organization_id FROM church_special_projects WHERE id = ? LIMIT 1`, [id]);
    if (rows.length === 0) return apiResponse(404, { error: 'Projeto não encontrado' });

    const tenantCheck = enforceTenant(auth.user, rows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    await query(`DELETE FROM church_special_projects WHERE id = ?`, [id]);
    return apiResponse(200, { message: 'Projeto removido com sucesso!' });
  } catch (error: any) {
    console.error('Erro ao remover projeto especial:', error);
    return apiResponse(500, { error: 'Erro ao remover projeto' });
  }
};

// ==========================================
// 4. FATURAS DE ASSINATURA SAAS FAITH-HUB
// ==========================================

export const listSaasInvoices = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const requestedOrgId = event.queryStringParameters?.organization_id;
    const tenantCheck = enforceTenant(auth.user, requestedOrgId);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    const orgId = tenantCheck.effectiveOrgId;
    const status = event.queryStringParameters?.status;

    let sql = `
      SELECT i.*, o.name as church_name, o.plan as current_plan
      FROM saas_invoices i
      LEFT JOIN organizations o ON o.id = i.organization_id
      WHERE i.organization_id = ?
    `;
    const params: any[] = [orgId];

    if (status) {
      sql += ` AND i.status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY i.due_date DESC LIMIT 50`;

    const { rows } = await query(sql, params);
    return apiResponse(200, { data: rows });
  } catch (error: any) {
    console.error('Erro ao listar faturas SaaS:', error);
    return apiResponse(500, { error: 'Erro ao listar faturas' });
  }
};

export const paySaasInvoice = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN']);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const id = event.pathParameters?.id || (event as any).rawPath?.split('/')[3];
    if (!id) return apiResponse(400, { error: 'ID da fatura obrigatório' });

    await query(`
      UPDATE saas_invoices
      SET status = 'PAID',
          paid_at = NOW()
      WHERE id = ?
    `, [id]);

    await logSecurityEvent({
      organizationId: auth.user.organizationId,
      user: auth.user,
      action: 'PAY_SAAS_INVOICE',
      resource: 'saas_invoices',
      resourceId: id,
      event
    });

    return apiResponse(200, { message: 'Fatura quitada com sucesso!' });
  } catch (error: any) {
    console.error('Erro ao quitar fatura SaaS:', error);
    return apiResponse(500, { error: 'Erro ao quitar fatura' });
  }
};

// ==========================================
// 5. FINANCIAL UNIFIED ROUTER (SERVERLESS ANY)
// ==========================================

export const financialHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = ((event.requestContext as any)?.http?.method || event.httpMethod || 'GET').toUpperCase();
  const rawPath = (event as any).rawPath || event.path || '';

  if (method === 'OPTIONS') {
    return apiResponse(200, { ok: true });
  }

  // 1. Resumo & DRE
  if (rawPath.includes('/financial/summary')) {
    if (method === 'GET') return getFinancialSummary(event);
  }

  // 2. Transações Financeiras (CRUD)
  if (rawPath.includes('/financial/transactions')) {
    const pathParts = rawPath.split('/').filter(Boolean);
    const lastPart = pathParts[pathParts.length - 1];
    if (lastPart !== 'transactions') {
      event.pathParameters = { ...(event.pathParameters || {}), id: lastPart };
    }

    if (method === 'GET') return listFinancialTransactions(event);
    if (method === 'POST') return createFinancialTransaction(event);
    if (method === 'PUT') return updateFinancialTransaction(event);
    if (method === 'DELETE') return deleteFinancialTransaction(event);
  }

  // 3. Projetos Especiais & Campanhas
  if (rawPath.includes('/financial/projects')) {
    const pathParts = rawPath.split('/').filter(Boolean);
    const lastPart = pathParts[pathParts.length - 1];
    if (lastPart !== 'projects') {
      event.pathParameters = { ...(event.pathParameters || {}), id: lastPart };
    }

    if (method === 'GET') return listSpecialProjects(event);
    if (method === 'POST') return createOrUpdateSpecialProject(event);
    if (method === 'DELETE') return deleteSpecialProject(event);
  }

  // 4. Faturas SaaS Faith-Hub
  if (rawPath.includes('/saas/invoices')) {
    if (rawPath.includes('/pay') && method === 'POST') return paySaasInvoice(event);
    if (method === 'GET') return listSaasInvoices(event);
  }

  return apiResponse(404, { message: 'Rota Financeira não encontrada' });
};
