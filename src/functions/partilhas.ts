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

// GET /partilhas?group_id=...&event_date=...
export const getPartilhas = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const groupId = event.queryStringParameters?.group_id;
    const connection = await getConnection();
    
    // Lista todas ou filtra, priorizando os eventos mais recentes ou futuros
    let query = `SELECT * FROM cell_partilhas WHERE cell_group_id = ? ORDER BY event_date >= CURDATE() DESC, event_date ASC, created_at DESC LIMIT 100`;
    const [rows] = await connection.query(query, [groupId]);
    await connection.end();

    return response(200, rows);
  } catch (error: any) {
    console.error('Error fetching partilhas:', error);
    return response(500, { message: 'Erro interno', error: error.message });
  }
};

// POST /partilhas
export const createPartilha = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { cell_group_id, user_id, user_name, item_name, quantity, event_date } = body;

    if (!cell_group_id || !user_id || !item_name || !event_date) {
      return response(400, { message: 'Campos obrigatórios faltando (cell_group_id, user_id, item_name, event_date)' });
    }

    const connection = await getConnection();
    const id = uuidv4();

    const q = `
      INSERT INTO cell_partilhas (id, cell_group_id, user_id, user_name, item_name, quantity, event_date, is_confirmed) 
      VALUES (?, ?, ?, ?, ?, ?, ?, false)
    `;

    await connection.query(q, [id, cell_group_id, user_id, user_name, item_name, quantity || '', event_date]);
    await connection.end();

    return response(201, { message: 'Partilha (Lanche) registrada com sucesso', id });
  } catch (error: any) {
    console.error('Error creating partilha:', error);
    return response(500, { message: 'Erro ao salvar partilha', error: error.message });
  }
};

// PUT /partilhas/{id}/toggle
export const togglePartilha = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    const body = JSON.parse(event.body || '{}');
    const { is_confirmed } = body;

    if (!id) return response(400, { message: 'ID é obrigatório' });

    const connection = await getConnection();
    await connection.query('UPDATE cell_partilhas SET is_confirmed = ? WHERE id = ?', [is_confirmed === true, id]);
    await connection.end();

    return response(200, { message: 'Status alterado com sucesso' });
  } catch (error: any) {
    console.error('Error updating partilha:', error);
    return response(500, { message: 'Erro interno', error });
  }
};

// DELETE /partilhas/{id}
export const deletePartilha = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return response(400, { message: 'ID é obrigatório' });

    const connection = await getConnection();
    await connection.query('DELETE FROM cell_partilhas WHERE id = ?', [id]);
    await connection.end();

    return response(200, { message: 'Removido com sucesso' });
  } catch (error: any) {
    return response(500, { message: 'Erro interno', error });
  }
};
