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

export const createOrUpdateGroup = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { id, name, leader_id, description, address, neighborhood, meeting_day, meeting_time, whatsapp_contact, status, focus } = body;

    const connection = await getConnection();
    const finalId = id || uuidv4();

    const q = `INSERT INTO cell_groups (id, name, leader_id, description, address, neighborhood, meeting_day, meeting_time, whatsapp_contact, status, focus) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'ACTIVE'), COALESCE(?, '@GERAL'))
               ON DUPLICATE KEY UPDATE 
               name=VALUES(name), leader_id=VALUES(leader_id), description=VALUES(description), 
               address=VALUES(address), neighborhood=VALUES(neighborhood), 
               meeting_day=VALUES(meeting_day), meeting_time=VALUES(meeting_time), 
               whatsapp_contact=VALUES(whatsapp_contact), status=VALUES(status), focus=VALUES(focus)`;

    await connection.query(q, [finalId, name, leader_id || null, description || null, address || null, neighborhood || null, meeting_day || null, meeting_time || null, whatsapp_contact || null, status, focus]);
    await connection.end();

    return response(id ? 200 : 201, { message: 'Célula/Grupo salva com sucesso', id: finalId });
  } catch (err: any) {
    console.error(err);
    return response(500, { error: err.message });
  }
};

export const getGroups = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const connection = await getConnection();

    // We join with the members table to get the leader name!
    const q = `
      SELECT cg.*, m.name as leader_name,
        (SELECT COUNT(*) FROM members WHERE pending_cell_group_id = cg.id) as pending_count
      FROM cell_groups cg 
      LEFT JOIN members m ON cg.leader_id = m.id 
      ORDER BY cg.name ASC
    `;
    const [rows] = await connection.query(q);
    await connection.end();

    return response(200, rows);
  } catch (err: any) {
    console.error(err);
    return response(500, { error: err.message });
  }
};

export const getGroup = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return response(400, { error: 'ID faltante' });

    const connection = await getConnection();
    const [rows]: any = await connection.query(`SELECT * FROM cell_groups WHERE id = ? LIMIT 1`, [id]);

    if (rows.length === 0) {
      await connection.end();
      return response(404, { message: 'Célula não encontrada' });
    }

    // Puxa os membros pedentes específicos desta célula para a tela de revisão
    const [pendingRows]: any = await connection.query(`SELECT id, name, phone, email FROM members WHERE pending_cell_group_id = ?`, [id]);
    await connection.end();

    const cellData = rows[0];
    cellData.pending_users = pendingRows || [];

    return response(200, cellData);
  } catch (err: any) {
    return response(500, { error: err.message });
  }
};

export const deleteGroup = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return response(400, { error: 'ID faltante' });

    const connection = await getConnection();
    await connection.query(`DELETE FROM cell_groups WHERE id = ?`, [id]);
    await connection.end();

    return response(200, { message: 'Célula deletada' });
  } catch (err: any) {
    return response(500, { error: err.message });
  }
};

export const evaluateRequest = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const groupId = event.pathParameters?.id;
    if (!groupId) return response(400, { error: 'Group ID faltante' });

    const body = JSON.parse(event.body || '{}');
    const { memberId, approved } = body;
    if (!memberId) return response(400, { error: 'Member ID faltante' });

    const connection = await getConnection();
    if (approved) {
      await connection.query(`UPDATE members SET cell_group_id = ?, pending_cell_group_id = NULL WHERE id = ? AND pending_cell_group_id = ?`, [groupId, memberId, groupId]);
    } else {
      await connection.query(`UPDATE members SET pending_cell_group_id = NULL WHERE id = ? AND pending_cell_group_id = ?`, [memberId, groupId]);
    }
    await connection.end();

    return response(200, { message: approved ? 'Membro aprovado na célula!' : 'Solicitação negada e removida' });
  } catch (err: any) {
    return response(500, { error: err.message });
  }
};
