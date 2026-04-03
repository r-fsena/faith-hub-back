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

// GET /events
export const getEvents = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const connection = await getConnection();

    // Puxa a listagem de Eventos e agrupa os Lotes Ativos num Array sub-json!
    // Usamos um JOIN simplificado
    const qEvents = `SELECT * FROM events WHERE status = 'PUBLISHED' ORDER BY start_date ASC LIMIT 50;`;
    const [eventsRow]: any = await connection.query(qEvents);

    if (eventsRow.length === 0) {
      await connection.end();
      return response(200, { data: [] });
    }

    const eventIds = eventsRow.map((e: any) => e.id);
    const qLots = `SELECT * FROM event_lots WHERE event_id IN (?) ORDER BY price ASC;`;
    const [lotsRow]: any = await connection.query(qLots, [eventIds]);
    await connection.end();

    const resultData = eventsRow.map((e: any) => ({
      ...e,
      lots: lotsRow.filter((l: any) => l.event_id === e.id)
    }));

    return response(200, { data: resultData });
  } catch (error: any) {
    console.error('Error fetching events:', error);
    return response(500, { message: 'Erro interno', error: error.message });
  }
};

// GET /events/{id}
export const getEventById = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return response(400, { message: 'ID é obrigatório' });

    const connection = await getConnection();
    const [eventRow]: any = await connection.query(`SELECT * FROM events WHERE id = ? LIMIT 1;`, [id]);

    if (eventRow.length === 0) {
      await connection.end();
      return response(404, { message: 'Evento não encontrado' });
    }

    const [lotsRow]: any = await connection.query(`SELECT * FROM event_lots WHERE event_id = ?;`, [id]);
    await connection.end();

    return response(200, { data: { ...eventRow[0], lots: lotsRow } });
  } catch (error: any) {
    return response(500, { message: 'Erro interno', error: error.message });
  }
};

// MOCK SETUP DE EVENTO CASO NÃO EXISTA NENHUM NO BD (Util para acelerar nosso desenvolvimento)
export const createMockEvent = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const connection = await getConnection();
    const evId = uuidv4();
    const videoUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // Example Video
    const galleryUrls = JSON.stringify([
      'https://images.unsplash.com/photo-1540575467063-178a50c2df87?q=80&w=800',
      'https://images.unsplash.com/photo-1523580494863-6f3031224c94?q=80&w=800',
      'https://images.unsplash.com/photo-1511795409834-ef04bbd61622?q=80&w=800'
    ]);

    const qE = `INSERT INTO events (id, type, is_featured, title, description, image_url, video_url, gallery_urls, start_date, end_date, location, status) 
      VALUES (?, 0, 1, 'Acampamento Faith 2026', 'Um acampamento espiritual inesquecível... Cheio de presença de Deus e diversão.', 'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?q=80&w=800', ?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY), DATE_ADD(NOW(), INTERVAL 33 DAY), 'Sitio das Montanhas, SP', 'PUBLISHED')`;

    await connection.query(qE, [evId, videoUrl, galleryUrls]);

    const l1Id = uuidv4();
    await connection.query(`INSERT INTO event_lots (id, event_id, name, price, total_capacity, available_capacity) VALUES (?, ?, '1º Lote (Promocional)', 150.00, 50, 50)`, [l1Id, evId]);

    const l2Id = uuidv4();
    await connection.query(`INSERT INTO event_lots (id, event_id, name, price, total_capacity, available_capacity) VALUES (?, ?, '2º Lote', 200.00, 100, 100)`, [l2Id, evId]);

    // MOCK DE CURSO (Type 1)
    const cId = uuidv4();
    const qC = `INSERT INTO events (id, type, is_featured, title, description, image_url, video_url, gallery_urls, start_date, end_date, location, status) 
      VALUES (?, 1, 0, 'Imersão em Liderança TKS', 'Curso intensivo de formação de líderes multiplicadores baseado nos valores reais do reino.', 'https://images.unsplash.com/photo-1515187029135-18ee286d815b?q=80&w=800', NULL, NULL, DATE_ADD(NOW(), INTERVAL 15 DAY), DATE_ADD(NOW(), INTERVAL 45 DAY), 'Campus Central / Online', 'PUBLISHED')`;
    await connection.query(qC, [cId]);
    await connection.query(`INSERT INTO event_lots (id, event_id, name, price, total_capacity, available_capacity) VALUES (?, ?, 'Lote Único (Membros)', 0.00, 200, 200)`, [uuidv4(), cId]);

    await connection.end();
    return response(201, { message: "Mock Event & Course gerados!", id: evId });
  } catch (e: any) {
    return response(500, { message: e.message });
  }
};

// POST /events
export const createOrUpdateEvent = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (!event.body) return response(400, { message: 'Body is required' });
    const data = JSON.parse(event.body);

    const connection = await getConnection();
    const isUpdate = !!data.id;
    const id = data.id || uuidv4();
    const type = data.type || 0;
    const isFeatured = data.is_featured ? 1 : 0;

    if (isUpdate) {
      const q = `UPDATE events SET type=?, is_featured=?, title=?, description=?, image_url=?, video_url=?, start_date=?, end_date=?, location=?, status=? WHERE id=?`;
      await connection.query(q, [type, isFeatured, data.title, data.description, data.image_url, data.video_url || null, data.start_date, data.end_date, data.location, data.status || 'PUBLISHED', id]);
    } else {
      const q = `INSERT INTO events (id, type, is_featured, title, description, image_url, video_url, start_date, end_date, location, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      await connection.query(q, [id, type, isFeatured, data.title, data.description, data.image_url, data.video_url || null, data.start_date, data.end_date, data.location, data.status || 'PUBLISHED']);
    }

    // Gerenciamento de LOTES atrelados ao Evento
    if (data.lots && Array.isArray(data.lots)) {
       for (const lot of data.lots) {
         if (lot.id) {
           // Atualizar lote existente (Mantemos o cálculo de available_capacity complexo seguro via trigger ou math simples)
           const qLot = `UPDATE event_lots SET name=?, price=?, total_capacity=? WHERE id=? AND event_id=?`;
           await connection.query(qLot, [lot.name, lot.price, lot.total_capacity, lot.id, id]);
         } else {
           // Novo lote
           const lId = uuidv4();
           const qLot = `INSERT INTO event_lots (id, event_id, name, price, total_capacity, available_capacity) VALUES (?, ?, ?, ?, ?, ?)`;
           await connection.query(qLot, [lId, id, lot.name, lot.price || 0, lot.total_capacity, lot.total_capacity]);
         }
       }
    } else if (!isUpdate) {
       // Se o frontend por algum erro não enviar lote no POST de criação, garantimos o fallback:
       const lId = uuidv4();
       await connection.query(`INSERT INTO event_lots (id, event_id, name, price, total_capacity, available_capacity) VALUES (?, ?, 'Lote Único', 0.00, 100, 100)`, [lId, id]);
    }

    await connection.end();
    return response(isUpdate ? 200 : 201, { message: "Salvo com sucesso!", id });
  } catch (e: any) {
    return response(500, { message: e.message });
  }
};

// DELETE /events/{id}
export const deleteEvent = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return response(400, { message: 'ID missing' });

    const connection = await getConnection();
    await connection.query(`DELETE FROM event_lots WHERE event_id = ?`, [id]);
    await connection.query(`DELETE FROM events WHERE id = ?`, [id]);
    await connection.end();

    return response(200, { message: "Evento deletado com sucesso!" });
  } catch (e: any) {
    return response(500, { message: e.message });
  }
};
