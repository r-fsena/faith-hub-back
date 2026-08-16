import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';

// GET /pdv/products
export const getProducts = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const admin = event.queryStringParameters?.admin === 'true';
    const sql = admin
      ? `SELECT * FROM pdv_products ORDER BY category, name`
      : `SELECT * FROM pdv_products WHERE status = 'ACTIVE' ORDER BY category, name`;

    const { rows } = await query(sql);

    const formatted = rows.map((r: any) => ({
      ...r,
      price: Number(r.price) || 0,
      image_urls: typeof r.image_urls === 'string' ? JSON.parse(r.image_urls || '[]') : (r.image_urls || [])
    }));

    return apiResponse(200, formatted);
  } catch (error: any) {
    return apiResponse(500, { message: 'Erro ao buscar produtos PDV', error: error.message });
  }
};

// POST /pdv/products
export const createOrUpdateProduct = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const isUpdate = !!body.id;
    const id = body.id || uuidv4();

    const qValues = [
      body.name,
      body.description || null,
      body.price || 0.00,
      body.category || 'Geral',
      body.image_urls ? JSON.stringify(body.image_urls) : '[]',
      body.status || 'DRAFT'
    ];

    if (isUpdate) {
      const uQ = `UPDATE pdv_products SET name=?, description=?, price=?, category=?, image_urls=?, status=? WHERE id=?`;
      await query(uQ, [...qValues, id]);
    } else {
      const iQ = `INSERT INTO pdv_products (name, description, price, category, image_urls, status, id) VALUES (?, ?, ?, ?, ?, ?, ?)`;
      await query(iQ, [...qValues, id]);
    }

    return apiResponse(isUpdate ? 200 : 201, { message: 'Produto salvo com sucesso!', id });
  } catch (err: any) {
    return apiResponse(500, { error: err.message });
  }
};

// DELETE /pdv/products/{id}
export const deleteProduct = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID é obrigatório' });

    await query(`DELETE FROM pdv_products WHERE id = ?`, [id]);
    return apiResponse(200, { message: 'Produto excluído com sucesso' });
  } catch (err: any) {
    return apiResponse(500, { error: err.message });
  }
};
