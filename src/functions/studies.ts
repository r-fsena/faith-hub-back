import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';

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

export const createOrUpdateStudy = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { id, title, description, content_type, link, date_published, status, target_group_id, content_text } = body;

    const connection = await getConnection();
    const finalId = id || uuidv4();

    const q = `INSERT INTO studies (id, title, description, content_type, link, date_published, status, target_group_id, content_text) 
               VALUES (?, ?, ?, COALESCE(?, 'TEXT'), ?, ?, COALESCE(?, 'ACTIVE'), ?, ?)
               ON DUPLICATE KEY UPDATE 
               title=VALUES(title), description=VALUES(description), content_type=VALUES(content_type), 
               link=VALUES(link), date_published=VALUES(date_published), status=VALUES(status), target_group_id=VALUES(target_group_id), content_text=VALUES(content_text)`;

    await connection.query(q, [finalId, title, description || null, content_type, link || null, date_published || null, status, target_group_id || null, content_text || null]);
    await connection.end();

    return response(id ? 200 : 201, { message: 'Estudo salvo com sucesso', id: finalId });
  } catch (err: any) {
    console.error(err);
    return response(500, { error: err.message });
  }
};

export const getStudies = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const connection = await getConnection();

    const groupId = event.queryStringParameters?.group_id;
    let q = `
      SELECT s.*, cg.name as target_group_name 
      FROM studies s 
      LEFT JOIN cell_groups cg ON s.target_group_id = cg.id 
    `;
    let params: any[] = [];

    // Filter by group_id if provided (for mobile app usage)
    if (groupId) {
      q += ` WHERE (s.target_group_id IS NULL OR s.target_group_id = ?) AND s.status = 'ACTIVE'`;
      params.push(groupId);
    }

    q += ` ORDER BY s.date_published DESC, s.created_at DESC`;

    const [rows] = await connection.query(q, params);
    await connection.end();

    return response(200, rows);
  } catch (err: any) {
    console.error(err);
    return response(500, { error: err.message });
  }
};

export const deleteStudy = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return response(400, { error: 'ID faltante' });

    const connection = await getConnection();
    await connection.query(`DELETE FROM studies WHERE id = ?`, [id]);
    await connection.end();

    return response(200, { message: 'Estudo deletado' });
  } catch (err: any) {
    return response(500, { error: err.message });
  }
};
