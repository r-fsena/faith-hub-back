import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, getConnection, apiResponse } from '../db';

// POST /tickets/checkout
export const checkout = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const connection = await getConnection();
  try {
    const body = JSON.parse(event.body || '{}');
    const { event_id, lot_id, user_id, attendee_name, attendee_whatsapp, attendee_cpf, dietary_notes, payment_method } = body;

    if (!event_id || !lot_id || !user_id) {
      connection.release();
      return apiResponse(400, { message: 'Requisição inválida (event_id, lot_id, user_id obrigatórios)' });
    }

    await connection.beginTransaction();

    // Bloqueia a linha do Lote para evitar Double Booking
    const [lotRow]: any = await connection.query(`SELECT * FROM event_lots WHERE id = ? FOR UPDATE;`, [lot_id]);
    
    if (lotRow.length === 0) {
      await connection.rollback();
      connection.release();
      return apiResponse(404, { message: 'Lote não existe' });
    }

    const lot = lotRow[0];

    if (lot.available_capacity <= 0) {
      await connection.rollback();
      connection.release();
      return apiResponse(400, { message: 'Ingressos esgotados neste Lote!' });
    }

    // Diminui o estoque disponível
    await connection.query(`UPDATE event_lots SET available_capacity = available_capacity - 1 WHERE id = ?`, [lot_id]);

    const qrCodeToken = `TICKET-${uuidv4().substring(0, 8).toUpperCase()}-${Date.now()}`;
    const ticketId = uuidv4();
    const isFree = Number(lot.price) === 0;
    const initialStatus = isFree ? 'PAID' : (payment_method === 'CREDIT_CARD' ? 'PAID' : 'PENDING');

    const qInsert = `
      INSERT INTO event_tickets (id, event_id, lot_id, user_id, status, qrcode_token, price_paid)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    await connection.query(qInsert, [ticketId, event_id, lot_id, user_id, initialStatus, qrCodeToken, lot.price]);

    await connection.commit();
    connection.release();

    return apiResponse(201, {
      message: 'Ingresso emitido com sucesso',
      ticket_id: ticketId,
      status: initialStatus,
      qrcode_token: qrCodeToken,
      qr_code_data: qrCodeToken,
      price_paid: lot.price,
      attendee: {
        name: attendee_name,
        whatsapp: attendee_whatsapp,
        cpf: attendee_cpf,
        dietary_notes
      }
    });
  } catch (error: any) {
    await connection.rollback();
    connection.release();
    console.error('Erro no checkout de ingresso:', error);
    return apiResponse(500, { message: 'Erro na emissão do ingresso', error: error.message });
  }
};

// GET /tickets/me?user_id=123
export const myTickets = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const userId = event.queryStringParameters?.user_id;
    if (!userId) return apiResponse(400, { message: 'user_id param obrigatório' });

    const sql = `
      SELECT t.id, t.qrcode_token, t.status, t.price_paid, t.created_at,
             e.title as event_title, e.start_date as event_date, e.location as event_location, e.image_url as event_image,
             l.name as lot_name
      FROM event_tickets t 
      JOIN events e ON t.event_id = e.id
      JOIN event_lots l ON t.lot_id = l.id
      WHERE t.user_id = ? 
      ORDER BY t.created_at DESC;
    `;
    
    const { rows } = await query(sql, [userId]);
    return apiResponse(200, { data: rows });
  } catch (err: any) {
    console.error('Erro ao buscar ingressos do membro:', err);
    return apiResponse(500, { error: err.message });
  }
};

// POST /tickets/scan
export const scanTicket = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const connection = await getConnection();
  try {
    const body = JSON.parse(event.body || '{}');
    const { token } = body;
    
    if (!token) {
      connection.release();
      return apiResponse(400, { isValid: false, message: 'Token de QR Code Ausente' });
    }

    await connection.beginTransaction();
    const [ticketRow]: any = await connection.query(
      `SELECT t.*, e.title as event_title, l.name as lot_name FROM event_tickets t 
       JOIN events e ON t.event_id = e.id 
       JOIN event_lots l ON t.lot_id = l.id 
       WHERE t.qrcode_token = ? FOR UPDATE;`,
      [token]
    );
    
    if (ticketRow.length === 0) {
      await connection.rollback();
      connection.release();
      return apiResponse(404, { isValid: false, message: 'Ingresso Inválido ou Não Encontrado!' });
    }

    const ticket = ticketRow[0];

    if (ticket.status === 'USED') {
      await connection.rollback();
      connection.release();
      return apiResponse(400, { isValid: false, message: `⚠️ Este ingresso JÁ FOI UTILIZADO em ${ticket.scanned_at || 'sessão anterior'}!` });
    }

    if (ticket.status === 'PENDING') {
      await connection.rollback();
      connection.release();
      return apiResponse(400, { isValid: false, message: '⚠️ Ingresso com Pagamento PENDENTE no sistema!' });
    }

    await connection.query(`UPDATE event_tickets SET status = 'USED', scanned_at = NOW() WHERE qrcode_token = ?`, [token]);
    
    await connection.commit();
    connection.release();

    return apiResponse(200, {
      isValid: true,
      message: '✅ Check-in Concluído com Sucesso! Acesso Liberado.',
      event: ticket.event_title,
      lot: ticket.lot_name
    });
  } catch (err: any) {
    await connection.rollback();
    connection.release();
    return apiResponse(500, { message: 'Falha no Scanner', error: err.message });
  }
};
