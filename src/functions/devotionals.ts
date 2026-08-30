import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';
import { requireAuth, enforceRole, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';

const PASTORAL_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER'];

// GET /devotionals?admin=true
export const getDevotionals = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const admin = event.queryStringParameters?.admin === 'true';
    const sql = admin
      ? `SELECT * FROM devotionals ORDER BY available_date DESC LIMIT 100`
      : `SELECT * FROM devotionals WHERE status = 'PUBLISHED' ORDER BY available_date DESC LIMIT 100`;

    const { rows } = await query(sql);
    return apiResponse(200, rows);
  } catch (error: any) {
    return apiResponse(500, { message: 'Erro ao buscar devocionais' });
  }
};

// GET /devotionals/today?user_id=123
export const getTodayDevotional = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const userId = event.queryStringParameters?.user_id || user?.userId;
    const dateParam = event.queryStringParameters?.date;
    const targetDate = dateParam || new Date().toISOString().split('T')[0];

    const { rows: devoRows } = await query(
      `SELECT * FROM devotionals WHERE available_date = ? AND status = 'PUBLISHED' LIMIT 1`,
      [targetDate]
    );

    if (devoRows.length === 0) {
      const { rows: latestRows } = await query(
        `SELECT * FROM devotionals WHERE status = 'PUBLISHED' ORDER BY available_date DESC LIMIT 1`
      );
      if (latestRows.length === 0) {
        return apiResponse(404, { message: 'Nenhum devocional disponível no momento.' });
      }
      devoRows.push(latestRows[0]);
    }

    const devotional = devoRows[0];
    let userNote = null;

    if (userId) {
      const { rows: noteRows } = await query(
        `SELECT * FROM devotional_notes WHERE devotional_id = ? AND user_id = ? LIMIT 1`,
        [devotional.id, userId]
      );
      if (noteRows.length > 0) {
        userNote = noteRows[0];
      }
    }

    return apiResponse(200, {
      ...devotional,
      user_note: userNote
    });
  } catch (error: any) {
    return apiResponse(500, { message: 'Erro ao buscar devocional de hoje' });
  }
};

// POST /devotionals
export const createOrUpdateDevotional = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, PASTORAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
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
      body.pastoral_author_name || auth.user.name,
      body.pastoral_author_role || auth.user.role,
      body.pastoral_author_avatar || null,
      body.pastoral_comment || null,
      body.status || 'DRAFT'
    ];

    if (isUpdate) {
      const sql = `
        UPDATE devotionals SET 
          available_date=?, title=?, source_type=?, source_name=?, suggested_song_title=?, suggested_song_youtube_id=?, 
          central_text=?, context_text=?, prayer_indication=?, pastoral_author_name=?, pastoral_author_role=?, pastoral_author_avatar=?, pastoral_comment=?, status=?
        WHERE id=?
      `;
      await query(sql, [...qValues, id]);
    } else {
      const sql = `
        INSERT INTO devotionals 
          (available_date, title, source_type, source_name, suggested_song_title, suggested_song_youtube_id, central_text, context_text, prayer_indication, pastoral_author_name, pastoral_author_role, pastoral_author_avatar, pastoral_comment, status, id) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      await query(sql, [...qValues, id]);
    }

    await logSecurityEvent({
      organizationId: auth.user.organizationId,
      user: auth.user,
      action: isUpdate ? 'UPDATE_DEVOTIONAL' : 'CREATE_DEVOTIONAL',
      resource: 'devotionals',
      resourceId: id,
      details: { title: body.title, available_date: body.available_date },
      event
    });

    return apiResponse(isUpdate ? 200 : 201, { message: 'Devocional salvo com sucesso!', id });
  } catch (error: any) {
    return apiResponse(500, { message: 'Erro ao salvar devocional' });
  }
};

// DELETE /devotionals/{id}
export const deleteDevotional = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN']);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID ausente' });

    await query(`DELETE FROM devotional_notes WHERE devotional_id = ?`, [id]);
    await query(`DELETE FROM devotionals WHERE id = ?`, [id]);

    await logSecurityEvent({
      organizationId: auth.user.organizationId,
      user: auth.user,
      action: 'DELETE_DEVOTIONAL',
      resource: 'devotionals',
      resourceId: id,
      event
    });

    return apiResponse(200, { message: 'Devocional removido com sucesso' });
  } catch (error: any) {
    return apiResponse(500, { message: 'Erro ao remover devocional' });
  }
};

// POST /devotionals/notes
export const saveUserNote = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const body = JSON.parse(event.body || '{}');
    const { devotional_id, user_id, note_text } = body;

    const effectiveUserId = user?.userId || user_id;

    if (!devotional_id || !effectiveUserId) {
      return apiResponse(400, { message: 'devotional_id e identificação do usuário são obrigatórios' });
    }

    const noteId = uuidv4();
    const sql = `
      INSERT INTO devotional_notes (id, devotional_id, user_id, note_text) 
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE note_text = VALUES(note_text), updated_at = NOW()
    `;

    await query(sql, [noteId, devotional_id, effectiveUserId, note_text]);

    return apiResponse(200, { message: 'Anotação pessoal salva com sucesso!' });
  } catch (error: any) {
    return apiResponse(500, { message: 'Erro ao salvar anotação' });
  }
};
