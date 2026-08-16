import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';
import { v4 as uuidv4 } from 'uuid';

export const listOrganizations = async (_event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const { rows } = await query(`
      SELECT o.*, 
             COUNT(DISTINCT c.id) as total_campuses,
             COUNT(DISTINCT m.id) as total_members
      FROM organizations o
      LEFT JOIN campuses c ON c.organization_id = o.id
      LEFT JOIN members m ON m.organization_id = o.id
      GROUP BY o.id
      ORDER BY o.created_at ASC
    `);
    return apiResponse(200, { data: rows });
  } catch (error: any) {
    console.error('Erro ao listar organizações:', error);
    return apiResponse(500, { error: error.message });
  }
};

export const getOrganization = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id || 'org_default';
    const { rows } = await query(`SELECT * FROM organizations WHERE id = ? OR slug = ? LIMIT 1`, [id, id]);
    if (rows.length === 0) {
      return apiResponse(404, { error: 'Organização não encontrada' });
    }
    return apiResponse(200, rows[0]);
  } catch (error: any) {
    console.error('Erro ao obter organização:', error);
    return apiResponse(500, { error: error.message });
  }
};

export const createOrUpdateOrganization = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { id, name, slug, cnpj, plan, primary_color, secondary_color, logo_url, status } = body;

    if (!name || !slug) {
      return apiResponse(400, { error: 'Nome e slug são campos obrigatórios' });
    }

    const orgId = id || uuidv4();
    const sql = `
      INSERT INTO organizations (id, name, slug, cnpj, plan, primary_color, secondary_color, logo_url, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        slug = VALUES(slug),
        cnpj = VALUES(cnpj),
        plan = VALUES(plan),
        primary_color = VALUES(primary_color),
        secondary_color = VALUES(secondary_color),
        logo_url = VALUES(logo_url),
        status = VALUES(status),
        updated_at = NOW()
    `;

    await query(sql, [
      orgId,
      name,
      slug.toLowerCase().trim().replace(/[^a-z0-9-]/g, '-'),
      cnpj || '',
      plan || 'PRO',
      primary_color || '#0f766e',
      secondary_color || '#14b8a6',
      logo_url || '',
      status || 'ACTIVE'
    ]);

    return apiResponse(200, { message: 'Organização salva com sucesso!', organization_id: orgId });
  } catch (error: any) {
    console.error('Erro ao salvar organização:', error);
    return apiResponse(500, { error: error.message });
  }
};
