import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, getConnection, apiResponse } from '../db';

// GET /events
export const getEvents = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const admin = event.queryStringParameters?.admin === 'true';
    const type = event.queryStringParameters?.type; // '0' = Evento, '1' = Curso
    const orgId = event.queryStringParameters?.organization_id;
    const campusId = event.queryStringParameters?.campus_id;

    let sqlEvents = `SELECT * FROM events WHERE 1=1`;
    const params: any[] = [];

    if (orgId && orgId !== 'all') {
      sqlEvents += ` AND organization_id = ?`;
      params.push(orgId);
    }

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
    return apiResponse(500, { message: 'Erro ao buscar eventos', error: error.message });
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
    return apiResponse(500, { message: 'Erro ao buscar detalhes do evento', error: error.message });
  }
};

// POST /events/mock
export const createMockEvent = async (_event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const connection = await getConnection();
  try {
    const evId = uuidv4();
    const l1Id = uuidv4();
    const l2Id = uuidv4();

    await connection.beginTransaction();

    const qEv = `
      INSERT INTO events (id, type, is_featured, title, description, image_url, video_url, start_date, end_date, location, status) 
      VALUES (?, 0, 1, 'Conferência Reino em Movimento 2026', 'Três dias de avivamento, capacitação profética e adoração intensa.', 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?q=80&w=800', NULL, DATE_ADD(NOW(), INTERVAL 7 DAY), DATE_ADD(NOW(), INTERVAL 9 DAY), 'Templo Principal - Sede', 'PUBLISHED')
    `;
    await connection.query(qEv, [evId]);
    await connection.query(`INSERT INTO event_lots (id, event_id, name, price, total_capacity, available_capacity) VALUES (?, ?, '1º Lote Solidário', 120.00, 50, 50)`, [l1Id, evId]);
    await connection.query(`INSERT INTO event_lots (id, event_id, name, price, total_capacity, available_capacity) VALUES (?, ?, '2º Lote', 200.00, 100, 100)`, [l2Id, evId]);

    const cId = uuidv4();
    const qC = `
      INSERT INTO events (id, type, is_featured, title, description, image_url, video_url, start_date, end_date, location, status) 
      VALUES (?, 1, 0, 'Imersão em Liderança TKS', 'Curso intensivo de formação de líderes multiplicadores baseado nos valores reais do reino.', 'https://images.unsplash.com/photo-1515187029135-18ee286d815b?q=80&w=800', NULL, DATE_ADD(NOW(), INTERVAL 15 DAY), DATE_ADD(NOW(), INTERVAL 45 DAY), 'Campus Central / Online', 'PUBLISHED')
    `;
    await connection.query(qC, [cId]);
    await connection.query(`INSERT INTO event_lots (id, event_id, name, price, total_capacity, available_capacity) VALUES (?, ?, 'Lote Único (Membros)', 0.00, 200, 200)`, [uuidv4(), cId]);

    await connection.commit();
    connection.release();

    return apiResponse(201, { message: 'Mock Event & Course gerados com sucesso!', id: evId });
  } catch (e: any) {
    await connection.rollback();
    connection.release();
    return apiResponse(500, { message: e.message });
  }
};

// POST /events
export const createOrUpdateEvent = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const connection = await getConnection();
  try {
    if (!event.body) {
      connection.release();
      return apiResponse(400, { message: 'Body obrigatório' });
    }
    const data = JSON.parse(event.body);

    const isUpdate = !!data.id;
    const id = data.id || uuidv4();
    const type = data.type || 0;
    const isFeatured = data.is_featured ? 1 : 0;

    await connection.beginTransaction();

    const orgValue = data.organization_id || 'org_default';
    const campusValue = data.campus_id || 'campus_sede';

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

    return apiResponse(isUpdate ? 200 : 201, { message: 'Evento salvo com sucesso!', id });
  } catch (e: any) {
    await connection.rollback();
    connection.release();
    return apiResponse(500, { message: e.message });
  }
};

// DELETE /events/{id}
export const deleteEvent = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const connection = await getConnection();
  try {
    const id = event.pathParameters?.id;
    if (!id) {
      connection.release();
      return apiResponse(400, { message: 'ID ausente' });
    }

    await connection.beginTransaction();
    await connection.query(`DELETE FROM event_tickets WHERE event_id = ?`, [id]);
    await connection.query(`DELETE FROM event_lots WHERE event_id = ?`, [id]);
    await connection.query(`DELETE FROM events WHERE id = ?`, [id]);
    await connection.commit();
    connection.release();

    return apiResponse(200, { message: 'Evento deletado com sucesso!' });
  } catch (e: any) {
    await connection.rollback();
    connection.release();
    return apiResponse(500, { message: e.message });
  }
};
