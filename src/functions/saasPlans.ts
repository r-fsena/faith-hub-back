// Gestão de Planos & Preços SaaS do Faith-Hub
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';

// 1. Listar Planos SaaS (GET /saas-plans)
export const listPlans = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const { rows } = await query(`
      SELECT * FROM saas_plans 
      ORDER BY monthly_price ASC
    `);

    const plans = rows.map((p: any) => {
      try {
        p.features = typeof p.features === 'string' ? JSON.parse(p.features || '[]') : p.features;
      } catch {
        p.features = [];
      }
      p.is_popular = Boolean(p.is_popular);
      return p;
    });

    return apiResponse(200, plans);
  } catch (error: any) {
    console.error('Erro ao listar planos:', error);
    return apiResponse(500, { message: 'Erro ao buscar planos SaaS', error: error.message });
  }
};

// 2. Criar ou Atualizar Plano SaaS (POST /saas-plans)
export const createOrUpdatePlan = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const {
      id,
      name,
      description,
      monthly_price,
      yearly_price,
      badge_text,
      is_popular,
      max_members,
      max_campuses,
      features,
      status
    } = body;

    if (!name || !monthly_price) {
      return apiResponse(400, { message: 'Nome e Preço Mensal são obrigatórios' });
    }

    const planId = (id || name).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const featuresJson = JSON.stringify(Array.isArray(features) ? features : []);

    const q = `
      INSERT INTO saas_plans (
        id, name, description, monthly_price, yearly_price, badge_text,
        is_popular, max_members, max_campuses, features, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        description = VALUES(description),
        monthly_price = VALUES(monthly_price),
        yearly_price = VALUES(yearly_price),
        badge_text = VALUES(badge_text),
        is_popular = VALUES(is_popular),
        max_members = VALUES(max_members),
        max_campuses = VALUES(max_campuses),
        features = VALUES(features),
        status = VALUES(status),
        updated_at = NOW()
    `;

    await query(q, [
      planId,
      name,
      description || '',
      Number(monthly_price),
      Number(yearly_price || (monthly_price * 10)),
      badge_text || null,
      Boolean(is_popular),
      Number(max_members || 0),
      Number(max_campuses || 1),
      featuresJson,
      status || 'ACTIVE'
    ]);

    return apiResponse(200, {
      message: 'Plano salvo com sucesso!',
      plan: {
        id: planId,
        name,
        monthly_price: Number(monthly_price),
        yearly_price: Number(yearly_price || (monthly_price * 10)),
        status: status || 'ACTIVE'
      }
    });
  } catch (error: any) {
    console.error('Erro ao salvar plano:', error);
    return apiResponse(500, { message: 'Erro ao salvar plano SaaS', error: error.message });
  }
};

// 3. Excluir / Desativar Plano SaaS (DELETE /saas-plans/{id})
export const deletePlan = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID do plano não informado' });

    await query(`DELETE FROM saas_plans WHERE id = ?`, [id]);

    return apiResponse(200, { message: 'Plano excluído com sucesso!' });
  } catch (error: any) {
    console.error('Erro ao excluir plano:', error);
    return apiResponse(500, { message: 'Erro ao excluir plano SaaS', error: error.message });
  }
};
