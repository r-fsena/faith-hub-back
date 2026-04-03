import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import mysql from 'mysql2/promise';

async function getConnection() {
  return await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub',
    ssl: { rejectUnauthorized: false }
  });
}

function response(statusCode: number, body: any) {
  return {
    statusCode,
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

export const getProducts = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const admin = event.queryStringParameters?.admin === 'true';
    const connection = await getConnection();
    
    // Admin sees all, App only sees ACTIVE
    const query = admin ? `SELECT * FROM pdv_products ORDER BY category, name` : `SELECT * FROM pdv_products WHERE status = 'ACTIVE' ORDER BY category, name`;
    
    const [rows]: any = await connection.query(query);
    await connection.end();
    return response(200, rows);
  } catch (error: any) {
    return response(500, { message: 'Erro ao buscar produtos PDV', error: error.message });
  }
};

export const createOrUpdateProduct = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const connection = await getConnection();

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
      await connection.query(uQ, [...qValues, id]);
    } else {
      const iQ = `INSERT INTO pdv_products (id, name, description, price, category, image_urls, status) VALUES (?, ?, ?, ?, ?, ?, ?)`;
      await connection.query(iQ, [id, ...qValues]);
    }

    await connection.end();
    return response(201, { message: 'Produto salvo com sucesso!', id });
  } catch (err: any) {
    return response(500, { error: err.message });
  }
};

export const deleteProduct = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return response(400, { message: 'ID é obrigatório' });
    const connection = await getConnection();
    await connection.query(`DELETE FROM pdv_products WHERE id = ?`, [id]);
    await connection.end();
    return response(200, { message: 'Produto excluído com sucesso' });
  } catch (err: any) {
    return response(500, { error: err.message });
  }
};
