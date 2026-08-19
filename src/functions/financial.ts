import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';
import { v4 as uuidv4 } from 'uuid';

// ==========================================
// 1. TRANSAÇÕES FINANCEIRAS (DÍZIMOS, OFERTAS, DESPESAS, PDV)
// ==========================================

export const listFinancialTransactions = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const orgId = event.queryStringParameters?.organization_id || 'org_default';
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
    return apiResponse(500, { error: error.message });
  }
};

export const createFinancialTransaction = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
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
      payment_date,
      created_by
    } = body;

    if (!organization_id || !type || !category || !description || amount === undefined) {
      return apiResponse(400, { error: 'Campos obrigatórios: organization_id, type, category, description, amount' });
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
      organization_id,
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
      created_by || null
    ]);

    // Se a transação for uma entrada vinculada a um projeto/campanha, atualiza o total arrecadado
    if (type === 'INCOME' && project_id && transStatus === 'PAID') {
      await query(`
        UPDATE church_special_projects
        SET collected_amount = collected_amount + ?
        WHERE id = ?
      `, [parseFloat(amount), project_id]);
    }

    return apiResponse(201, { message: 'Transação registrada com sucesso!', id });
  } catch (error: any) {
    console.error('Erro ao registrar transação financeira:', error);
    return apiResponse(500, { error: error.message });
  }
};

export const updateFinancialTransaction = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID da transação obrigatório' });

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

    return apiResponse(200, { message: 'Transação atualizada com sucesso!' });
  } catch (error: any) {
    console.error('Erro ao atualizar transação financeira:', error);
    return apiResponse(500, { error: error.message });
  }
};

export const deleteFinancialTransaction = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID da transação obrigatório' });

    await query(`DELETE FROM church_financial_transactions WHERE id = ?`, [id]);
    return apiResponse(200, { message: 'Transação removida com sucesso!' });
  } catch (error: any) {
    console.error('Erro ao remover transação financeira:', error);
    return apiResponse(500, { error: error.message });
  }
};

// ==========================================
// 2. RESUMO FINANCEIRO & DRE
// ==========================================

export const getFinancialSummary = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const orgId = event.queryStringParameters?.organization_id || 'org_default';
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
    const { rows: incomeByCategory } = await query(`
      SELECT category, SUM(amount) as total, COUNT(id) as count
      FROM church_financial_transactions
      WHERE organization_id = ? AND type = 'INCOME' AND status = 'PAID' ${campusFilter} ${dateFilter}
      GROUP BY category
      ORDER BY total DESC
    `, params);

    // Saídas por Categoria
    const { rows: expenseByCategory } = await query(`
      SELECT category, SUM(amount) as total, COUNT(id) as count
      FROM church_financial_transactions
      WHERE organization_id = ? AND type = 'EXPENSE' AND status = 'PAID' ${campusFilter} ${dateFilter}
      GROUP BY category
      ORDER BY total DESC
    `, params);

    // Entradas por Forma de Pagamento
    const { rows: incomeByMethod } = await query(`
      SELECT payment_method, SUM(amount) as total, COUNT(id) as count
      FROM church_financial_transactions
      WHERE organization_id = ? AND type = 'INCOME' AND status = 'PAID' ${campusFilter} ${dateFilter}
      GROUP BY payment_method
      ORDER BY total DESC
    `, params);

    const totalIncome = parseFloat(totals[0]?.total_income || '0');
    const totalExpense = parseFloat(totals[0]?.total_expense || '0');
    const netBalance = totalIncome - totalExpense;

    return apiResponse(200, {
      total_income: totalIncome,
      total_expense: totalExpense,
      net_balance: netBalance,
      pending_income: parseFloat(totals[0]?.pending_income || '0'),
      pending_expense: parseFloat(totals[0]?.pending_expense || '0'),
      total_transactions: parseInt(totals[0]?.total_transactions || '0'),
      income_by_category: incomeByCategory,
      expense_by_category: expenseByCategory,
      income_by_method: incomeByMethod
    });
  } catch (error: any) {
    console.error('Erro ao obter resumo financeiro:', error);
    return apiResponse(500, { error: error.message });
  }
};

// ==========================================
// 3. PROJETOS ESPECIAIS & CAMPANHAS COM METAS
// ==========================================

export const listSpecialProjects = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const orgId = event.queryStringParameters?.organization_id || 'org_default';
    const status = event.queryStringParameters?.status;

    let sql = `
      SELECT p.*,
             COUNT(t.id) as total_donations,
             SUM(CASE WHEN t.status = 'PAID' THEN t.amount ELSE 0 END) as calculated_collected
      FROM church_special_projects p
      LEFT JOIN church_financial_transactions t ON t.project_id = p.id
      WHERE p.organization_id = ?
    `;
    const params: any[] = [orgId];

    if (status) {
      sql += ` AND p.status = ?`;
      params.push(status);
    }

    sql += ` GROUP BY p.id ORDER BY p.created_at DESC`;

    const { rows } = await query(sql, params);
    return apiResponse(200, { data: rows });
  } catch (error: any) {
    console.error('Erro ao listar projetos especiais:', error);
    return apiResponse(500, { error: error.message });
  }
};

export const createOrUpdateSpecialProject = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
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

    if (!organization_id || !title || target_amount === undefined) {
      return apiResponse(400, { error: 'Campos obrigatórios: organization_id, title, target_amount' });
    }

    const projId = id || uuidv4();
    const startDate = start_date || new Date().toISOString().split('T')[0];
    const projStatus = status || 'ACTIVE';

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
        status = VALUES(status)
    `, [
      projId,
      organization_id,
      campus_id || null,
      title,
      description || null,
      image_url || null,
      parseFloat(target_amount),
      collected_amount !== undefined ? parseFloat(collected_amount) : 0.00,
      startDate,
      end_date || null,
      pix_key || null,
      projStatus
    ]);

    return apiResponse(200, { message: 'Projeto/Campanha salvo com sucesso!', id: projId });
  } catch (error: any) {
    console.error('Erro ao salvar projeto especial:', error);
    return apiResponse(500, { error: error.message });
  }
};

export const deleteSpecialProject = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID do projeto obrigatório' });

    await query(`DELETE FROM church_special_projects WHERE id = ?`, [id]);
    return apiResponse(200, { message: 'Projeto removido com sucesso!' });
  } catch (error: any) {
    console.error('Erro ao remover projeto:', error);
    return apiResponse(500, { error: error.message });
  }
};

// ==========================================
// 4. FATURAS DE ASSINATURA SAAS FAITH-HUB
// ==========================================

export const listSaasInvoices = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const orgId = event.queryStringParameters?.organization_id;
    let sql = `
      SELECT i.*,
             o.name as church_name,
             p.name as plan_name,
             p.monthly_price,
             p.yearly_price
      FROM saas_invoices i
      LEFT JOIN organizations o ON o.id = i.organization_id
      LEFT JOIN saas_plans p ON p.id = i.plan_id
    `;
    const params: any[] = [];

    if (orgId) {
      sql += ` WHERE i.organization_id = ?`;
      params.push(orgId);
    }

    sql += ` ORDER BY i.due_date DESC LIMIT 50`;

    const { rows } = await query(sql, params);
    return apiResponse(200, { data: rows });
  } catch (error: any) {
    console.error('Erro ao listar faturas SaaS:', error);
    return apiResponse(500, { error: error.message });
  }
};

export const paySaasInvoice = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id || event.rawPath?.split('/')[3];
    if (!id) return apiResponse(400, { error: 'ID da fatura obrigatório' });

    await query(`
      UPDATE saas_invoices
      SET status = 'PAID',
          paid_at = NOW()
      WHERE id = ?
    `, [id]);

    return apiResponse(200, { message: 'Fatura quitada com sucesso!' });
  } catch (error: any) {
    console.error('Erro ao quitar fatura SaaS:', error);
    return apiResponse(500, { error: error.message });
  }
};

// ==========================================
// 5. FINANCIAL UNIFIED ROUTER (SERVERLESS ANY)
// ==========================================

export const financialHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
  const rawPath = event.rawPath || event.path || '';

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
