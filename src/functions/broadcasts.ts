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

export const createOrUpdateBroadcast = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { id, title, description, observation, youtube_url, is_available, scheduled_for } = body;

    const connection = await getConnection();

    const finalId = id || uuidv4();
    const q = `INSERT INTO broadcasts (id, title, description, observation, youtube_url, is_available, scheduled_for) 
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE 
               title=VALUES(title), description=VALUES(description), observation=VALUES(observation), youtube_url=VALUES(youtube_url), is_available=VALUES(is_available), scheduled_for=VALUES(scheduled_for)`;

    await connection.query(q, [finalId, title, description, observation, youtube_url, is_available ? 1 : 0, scheduled_for || null]);
    await connection.end();

    return response(id ? 200 : 201, { message: 'Broadcast salva com sucesso', id: finalId });
  } catch (err: any) {
    console.error(err);
    return response(500, { error: err.message });
  }
};

export const getBroadcasts = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const connection = await getConnection();
    const [rows] = await connection.query(`SELECT * FROM broadcasts ORDER BY scheduled_for ASC, created_at DESC`);
    await connection.end();

    return response(200, rows);
  } catch (err: any) {
    console.error(err);
    return response(500, { error: err.message });
  }
};

export const getActiveBroadcast = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const connection = await getConnection();
    // Pega as disponíveis (ignorando a default)
    const [rows]: any = await connection.query(`SELECT * FROM broadcasts WHERE is_available = 1 AND id != 'default' ORDER BY updated_at DESC LIMIT 1`);

    if (rows.length > 0) {
      await connection.end();
      return response(200, rows[0]);
    }

    // Se não tem nada de emergência/ao vivo rolando, retorna a padrão
    const [defRows]: any = await connection.query(`SELECT * FROM broadcasts WHERE id = 'default' LIMIT 1`);
    await connection.end();

    if (defRows.length > 0) {
      return response(200, defRows[0]);
    }

    return response(404, { message: 'Nenhuma transmissão ativa no momento' });
  } catch (err: any) {
    console.error(err);
    return response(500, { error: err.message });
  }
};

export const deleteBroadcast = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return response(400, { error: 'ID faltante' });

    const connection = await getConnection();
    await connection.query(`DELETE FROM broadcasts WHERE id = ?`, [id]);
    await connection.end();

    return response(200, { message: 'Broadcast deletada' });
  } catch (err: any) {
    return response(500, { error: err.message });
  }
};
