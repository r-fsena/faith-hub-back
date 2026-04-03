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

export const getPosts = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const groupId = event.queryStringParameters?.group_id;
    const mediaOnly = event.queryStringParameters?.media_only === 'true';
    
    const connection = await getConnection();
    
    let query = `
      SELECT id, cell_group_id, author_id, author_name, content_text, media_url, media_type, created_at 
      FROM board_posts
      WHERE (cell_group_id = ? OR cell_group_id IS NULL)
    `;
    const params: any[] = [groupId || null];

    if (mediaOnly) {
      query += ` AND media_type IN ('IMAGE', 'VIDEO') `;
    }

    query += ` ORDER BY created_at DESC LIMIT 50`;

    const [rows] = await connection.query(query, params);
    await connection.end();

    return response(200, rows);
  } catch (error: any) {
    console.error('Error fetching posts:', error);
    return response(500, { message: 'Erro ao buscar mural', error: error.message });
  }
};

export const createPost = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { cell_group_id, author_id, author_name, content_text, media_url, media_type } = body;

    if (!author_id || !author_name) {
      return response(400, { message: 'author_id e author_name são obrigatórios' });
    }

    const connection = await getConnection();
    const id = uuidv4();

    const q = `
      INSERT INTO board_posts (id, cell_group_id, author_id, author_name, content_text, media_url, media_type) 
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    await connection.query(q, [
      id, 
      cell_group_id || null, 
      author_id, 
      author_name, 
      content_text || null, 
      media_url || null, 
      media_type || 'NONE'
    ]);
    
    await connection.end();

    return response(201, { message: 'Post enviado com sucesso', id });
  } catch (error: any) {
    console.error('Error creating post:', error);
    return response(500, { message: 'Erro ao salvar post', error: error.message });
  }
};

export const deletePost = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return response(400, { message: 'ID é obrigatório' });

    const connection = await getConnection();
    await connection.query('DELETE FROM board_posts WHERE id = ?', [id]);
    await connection.end();

    return response(200, { message: 'Deletado com sucesso' });
  } catch (error: any) {
    console.error('Error deleting post:', error);
    return response(500, { message: 'Erro interno', error });
  }
};
