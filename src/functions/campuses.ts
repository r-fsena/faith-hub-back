import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';
import { v4 as uuidv4 } from 'uuid';

export const listCampuses = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const orgId = event.queryStringParameters?.organization_id || 'org_default';
    const { rows } = await query(`
      SELECT c.*,
             COUNT(DISTINCT m.id) as total_members,
             COUNT(DISTINCT cg.id) as total_cells
      FROM campuses c
      LEFT JOIN members m ON m.campus_id = c.id
      LEFT JOIN cell_groups cg ON cg.campus_id = c.id
      WHERE c.organization_id = ?
      GROUP BY c.id
      ORDER BY c.is_headquarters DESC, c.created_at ASC
    `, [orgId]);

    return apiResponse(200, { data: rows });
  } catch (error: any) {
    console.error('Erro ao listar unidades/campi:', error);
    return apiResponse(500, { error: error.message });
  }
};

export const getCampus = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID do campus obrigatório' });

    const { rows } = await query(`SELECT * FROM campuses WHERE id = ? OR slug = ? LIMIT 1`, [id, id]);
    if (rows.length === 0) {
      return apiResponse(404, { error: 'Campus/Unidade não encontrado' });
    }
    return apiResponse(200, rows[0]);
  } catch (error: any) {
    console.error('Erro ao obter campus:', error);
    return apiResponse(500, { error: error.message });
  }
};

export const createOrUpdateCampus = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const {
      id,
      organization_id,
      name,
      slug,
      is_headquarters,
      pastor_name,
      phone,
      whatsapp,
      email,
      address,
      neighborhood,
      city,
      state,
      status
    } = body;

    if (!name || !slug) {
      return apiResponse(400, { error: 'Nome da unidade e slug são obrigatórios' });
    }

    const orgId = organization_id || 'org_default';
    const campusId = id || uuidv4();
    const formattedSlug = slug.toLowerCase().trim().replace(/[^a-z0-9-]/g, '-');

    // Se for marcado como sede, desmarca os outros
    if (is_headquarters) {
      await query(`UPDATE campuses SET is_headquarters = FALSE WHERE organization_id = ?`, [orgId]);
    }

    const sql = `
      INSERT INTO campuses (
        id, organization_id, name, slug, is_headquarters,
        pastor_name, phone, whatsapp, email,
        address, neighborhood, city, state, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        slug = VALUES(slug),
        is_headquarters = VALUES(is_headquarters),
        pastor_name = VALUES(pastor_name),
        phone = VALUES(phone),
        whatsapp = VALUES(whatsapp),
        email = VALUES(email),
        address = VALUES(address),
        neighborhood = VALUES(neighborhood),
        city = VALUES(city),
        state = VALUES(state),
        status = VALUES(status),
        updated_at = NOW()
    `;

    await query(sql, [
      campusId,
      orgId,
      name,
      formattedSlug,
      is_headquarters ? 1 : 0,
      pastor_name || '',
      phone || '',
      whatsapp || '',
      email || '',
      address || '',
      neighborhood || '',
      city || '',
      state || '',
      status || 'ACTIVE'
    ]);

    return apiResponse(200, {
      message: 'Unidade/Campus salvo com sucesso!',
      campus_id: campusId
    });
  } catch (error: any) {
    console.error('Erro ao salvar campus:', error);
    return apiResponse(500, { error: error.message });
  }
};

export const deleteCampus = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID do campus obrigatório' });

    // Não permite apagar se for a Sede
    const { rows } = await query(`SELECT is_headquarters FROM campuses WHERE id = ?`, [id]);
    if (rows.length > 0 && rows[0].is_headquarters) {
      return apiResponse(400, { error: 'A Sede Principal não pode ser excluída. Transfira a sede para outra unidade antes.' });
    }

    await query(`DELETE FROM campuses WHERE id = ?`, [id]);
    return apiResponse(200, { message: 'Unidade/Campus removido com sucesso' });
  } catch (error: any) {
    console.error('Erro ao excluir campus:', error);
    return apiResponse(500, { error: error.message });
  }
};
