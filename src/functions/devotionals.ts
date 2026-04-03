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

// GET /devotionals?admin=true -> Admin fetch all
export const getDevotionals = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const connection = await getConnection();
    const query = `SELECT * FROM devotionals ORDER BY available_date DESC LIMIT 100`;
    const [rows]: any = await connection.query(query);
    await connection.end();
    return response(200, rows);
  } catch (error: any) {
    return response(500, { message: 'Erro ao buscar devocionais', error: error.message });
  }
};

// GET /devotionals/today?user_id=123 -> App fetch today's devotional + user personal notes
export const getTodayDevotional = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const userId = event.queryStringParameters?.user_id;
    const dateParam = event.queryStringParameters?.date; // Optional, to fetch specific day on calendar

    const connection = await getConnection();
    
    // Find devotional by specific Date or Today (UTC-3 adjustment implicitly usually, but we match exactly YYYY-MM-DD)
    const targetDate = dateParam || new Date().toISOString().split('T')[0];
    
    const [devoRows]: any = await connection.query(`SELECT * FROM devotionals WHERE available_date = ? AND status = 'PUBLISHED' LIMIT 1`, [targetDate]);

    if (devoRows.length === 0) {
      await connection.end();
      return response(404, { message: 'Nenhum devocional agendado para o dia de hoje.' });
    }

    const devotional = devoRows[0];
    let userNote = null;

    if (userId) {
      const [noteRows]: any = await connection.query(`SELECT * FROM devotional_notes WHERE devotional_id = ? AND user_id = ? LIMIT 1`, [devotional.id, userId]);
      if (noteRows.length > 0) {
        userNote = noteRows[0];
      }
    }

    await connection.end();

    return response(200, {
      ...devotional,
      user_note: userNote
    });
  } catch (error: any) {
    return response(500, { error: error.message });
  }
};

// POST /devotionals -> Create/Update (Admin)
export const createOrUpdateDevotional = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const connection = await getConnection();

    const isUpdate = !!body.id;
    const id = body.id || uuidv4();

    const qValues = [
      body.available_date,
      body.title,
      body.source_type || 'LOCAL',
      body.source_name || null,
      body.suggested_song_title || null,
      body.suggested_song_youtube_id || null,
      body.central_text,
      body.context_text,
      body.prayer_indication,
      body.pastoral_author_name || null,
      body.pastoral_author_role || null,
      body.pastoral_author_avatar || null,
      body.pastoral_comment || null,
      body.status || 'DRAFT'
    ];

    if (isUpdate) {
      const uQ = `UPDATE devotionals SET 
        available_date=?, title=?, source_type=?, source_name=?, suggested_song_title=?, suggested_song_youtube_id=?, 
        central_text=?, context_text=?, prayer_indication=?, pastoral_author_name=?, pastoral_author_role=?, 
        pastoral_author_avatar=?, pastoral_comment=?, status=? WHERE id=?`;
      await connection.query(uQ, [...qValues, id]);
    } else {
      const iQ = `INSERT INTO devotionals (
        id, available_date, title, source_type, source_name, suggested_song_title, suggested_song_youtube_id, 
        central_text, context_text, prayer_indication, pastoral_author_name, pastoral_author_role, 
        pastoral_author_avatar, pastoral_comment, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      await connection.query(iQ, [id, ...qValues]);
    }

    await connection.end();
    return response(201, { message: 'Devocional salvo com sucesso!', id });
  } catch (err: any) {
    return response(500, { error: err.message });
  }
};

// DELETE /devotionals/{id}
export const deleteDevotional = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return response(400, { message: 'ID é obrigatório' });
    const connection = await getConnection();
    await connection.query(`DELETE FROM devotionals WHERE id = ?`, [id]);
    await connection.end();
    return response(200, { message: 'Excluído com sucesso' });
  } catch (err: any) {
    return response(500, { error: err.message });
  }
};

// POST /devotionals/notes -> User saves their answers/reflections
export const saveUserNote = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { devotional_id, user_id, notes_text, status } = body;
    
    if (!devotional_id || !user_id) return response(400, { error: 'Faltando ID do devocional e/ou user_id' });

    const connection = await getConnection();
    
    const id = uuidv4();
    const finalStatus = status || 'completed';

    // Usando On Duplicate Key Update (UPSERT) nativo!
    const qUPSERT = `
      INSERT INTO devotional_notes (id, devotional_id, user_id, notes_text, status, completed_at)
      VALUES (?, ?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE notes_text = VALUES(notes_text), status = VALUES(status), completed_at = NOW();
    `;

    await connection.query(qUPSERT, [id, devotional_id, user_id, notes_text, finalStatus]);
    await connection.end();

    return response(200, { message: 'Observações de Devocional Salvas na Nuvem' });
  } catch (err: any) {
    return response(500, { error: err.message });
  }
};
