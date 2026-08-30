import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, getConnection, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';

const EVENT_ADMIN_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER'];

// GET /events
export const getEvents = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const admin = event.queryStringParameters?.admin === 'true';
    const type = event.queryStringParameters?.type; // '0' = Evento, '1' = Curso
    const requestedOrgId = event.queryStringParameters?.organization_id;
    const campusId = event.queryStringParameters?.campus_id;

    const orgId = user ? enforceTenant(user, requestedOrgId).effectiveOrgId : (requestedOrgId || 'org_default');

    let sqlEvents = `SELECT * FROM events WHERE organization_id = ?`;
    const params: any[] = [orgId];

    if (campusId && campusId !== 'all') {
      sqlEvents += ` AND (campus_id = ? OR campus_id IS NULL)`;
      params.push(campusId);
    }

    if (!admin) {
      sqlEvents += ` AND status = 'PUBLISHED'`;
    }

    if (type !== undefined && type !== '') {
      sqlEvents += ` AND type = ?`;
      params.push(Number(type));
    }

    sqlEvents += ` ORDER BY start_date ASC LIMIT 100`;

    const { rows: eventsRow } = await query(sqlEvents, params);

    if (eventsRow.length === 0) {
      return apiResponse(200, { data: [] });
    }

    const eventIds = eventsRow.map((e: any) => e.id);
    const { rows: lotsRow } = await query(
      `SELECT * FROM event_lots WHERE event_id IN (?) ORDER BY price ASC`,
      [eventIds]
    );

    const resultData = eventsRow.map((e: any) => ({
      ...e,
      type: Number(e.type) || 0,
      is_featured: Boolean(e.is_featured),
      lots: lotsRow.filter((l: any) => l.event_id === e.id)
    }));

    return apiResponse(200, { data: resultData });
  } catch (error: any) {
    console.error('Error fetching events:', error);
    return apiResponse(500, { message: 'Erro ao buscar eventos' });
  }
};

// GET /events/{id}
export const getEventById = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID é obrigatório' });

    const { rows: eventRow } = await query(`SELECT * FROM events WHERE id = ? LIMIT 1`, [id]);

    if (eventRow.length === 0) {
      return apiResponse(404, { message: 'Evento não encontrado' });
    }

    const { rows: lotsRow } = await query(`SELECT * FROM event_lots WHERE event_id = ? ORDER BY price ASC`, [id]);

    const ev = eventRow[0];
    return apiResponse(200, {
      data: {
        ...ev,
        type: Number(ev.type) || 0,
        is_featured: Boolean(ev.is_featured),
        lots: lotsRow
      }
    });
  } catch (error: any) {
    return apiResponse(500, { message: 'Erro ao buscar detalhes do evento' });
  }
};

// POST /events
export const createOrUpdateEvent = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const connection = await getConnection();
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) {
      connection.release();
      return auth.errorResponse;
    }

    const roleCheck = enforceRole(auth.user, EVENT_ADMIN_ROLES);
    if (!roleCheck.allowed) {
      connection.release();
      return roleCheck.errorResponse!;
    }

    if (!event.body) {
      connection.release();
      return apiResponse(400, { message: 'Body obrigatório' });
    }
    const data = JSON.parse(event.body);

    const tenantCheck = enforceTenant(auth.user, data.organization_id);
    if (!tenantCheck.allowed) {
      connection.release();
      return tenantCheck.errorResponse!;
    }
    const orgValue = tenantCheck.effectiveOrgId;

    const isUpdate = !!data.id;
    const id = data.id || uuidv4();
    const type = data.type || 0;
    const isFeatured = data.is_featured ? 1 : 0;
    const campusValue = data.campus_id || 'campus_sede';

    await connection.beginTransaction();

    if (isUpdate) {
      const q = `UPDATE events SET type=?, is_featured=?, title=?, description=?, image_url=?, video_url=?, start_date=?, end_date=?, location=?, status=?, campus_id=? WHERE id=?`;
      await connection.query(q, [type, isFeatured, data.title, data.description, data.image_url, data.video_url || null, data.start_date, data.end_date, data.location, data.status || 'PUBLISHED', campusValue, id]);
    } else {
      const q = `INSERT INTO events (id, type, is_featured, title, description, image_url, video_url, start_date, end_date, location, status, organization_id, campus_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      await connection.query(q, [id, type, isFeatured, data.title, data.description, data.image_url, data.video_url || null, data.start_date, data.end_date, data.location, data.status || 'PUBLISHED', orgValue, campusValue]);
    }

    // Gerenciamento de LOTES
    if (data.lots && Array.isArray(data.lots)) {
      for (const lot of data.lots) {
        if (lot.id) {
          const qLot = `UPDATE event_lots SET name=?, price=?, total_capacity=? WHERE id=? AND event_id=?`;
          await connection.query(qLot, [lot.name, lot.price, lot.total_capacity, lot.id, id]);
        } else {
          const lId = uuidv4();
          const qLot = `INSERT INTO event_lots (id, event_id, name, price, total_capacity, available_capacity) VALUES (?, ?, ?, ?, ?, ?)`;
          await connection.query(qLot, [lId, id, lot.name, lot.price || 0, lot.total_capacity, lot.total_capacity]);
        }
      }
    } else if (!isUpdate) {
      const lId = uuidv4();
      await connection.query(`INSERT INTO event_lots (id, event_id, name, price, total_capacity, available_capacity) VALUES (?, ?, 'Lote Único', 0.00, 100, 100)`, [lId, id]);
    }

    await connection.commit();
    connection.release();

    await logSecurityEvent({
      organizationId: orgValue,
      user: auth.user,
      action: isUpdate ? 'UPDATE_EVENT' : 'CREATE_EVENT',
      resource: 'events',
      resourceId: id,
      details: { title: data.title, type },
      event
    });

    return apiResponse(isUpdate ? 200 : 201, { message: 'Evento salvo com sucesso!', id });
  } catch (e: any) {
    await connection.rollback();
    connection.release();
    return apiResponse(500, { message: 'Erro ao salvar evento' });
  }
};

// DELETE /events/{id}
export const deleteEvent = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const connection = await getConnection();
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) {
      connection.release();
      return auth.errorResponse;
    }

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN']);
    if (!roleCheck.allowed) {
      connection.release();
      return roleCheck.errorResponse!;
    }

    const id = event.pathParameters?.id;
    if (!id) {
      connection.release();
      return apiResponse(400, { message: 'ID ausente' });
    }

    const [rows]: any = await connection.query(`SELECT organization_id, title FROM events WHERE id = ? LIMIT 1`, [id]);
    if (rows.length === 0) {
      connection.release();
      return apiResponse(404, { message: 'Evento não encontrado' });
    }

    const tenantCheck = enforceTenant(auth.user, rows[0].organization_id);
    if (!tenantCheck.allowed) {
      connection.release();
      return tenantCheck.errorResponse!;
    }

    await connection.beginTransaction();
    await connection.query(`DELETE FROM event_tickets WHERE event_id = ?`, [id]);
    await connection.query(`DELETE FROM event_lots WHERE event_id = ?`, [id]);
    await connection.query(`DELETE FROM events WHERE id = ?`, [id]);
    await connection.commit();
    connection.release();

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'DELETE_EVENT',
      resource: 'events',
      resourceId: id,
      details: { title: rows[0].title },
      event
    });

    return apiResponse(200, { message: 'Evento deletado com sucesso!' });
  } catch (e: any) {
    await connection.rollback();
    connection.release();
    return apiResponse(500, { message: 'Erro ao deletar evento' });
  }
};
