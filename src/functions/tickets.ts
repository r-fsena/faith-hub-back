import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, getConnection, apiResponse } from '../db';
import { requireAuth, enforceRole, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';
import { checkRateLimit } from '../services/rateLimiter';

const SCANNER_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER', 'VOLUNTEER'];

// Gerador de Código Curto de Validação Manual (ex: FH-784291)
const generateShortCode = (): string => {
  const num = Math.floor(100000 + Math.random() * 900000);
  return `FH-${num}`;
};

// POST /tickets/checkout
export const checkout = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const connection = await getConnection();
  try {
    const rateCheck = checkRateLimit(event, {
      maxRequests: 20,
      windowSeconds: 60,
      identifierPrefix: 'ticket_checkout'
    });
    if (!rateCheck.allowed) {
      connection.release();
      return rateCheck.errorResponse!;
    }

    const user = await getAuthenticatedUser(event);
    const body = JSON.parse(event.body || '{}');
    const {
      event_id,
      lot_id,
      user_id,
      attendee_name,
      attendee_whatsapp,
      attendee_cpf,
      attendee_email,
      dietary_notes,
      payment_method
    } = body;

    const effectiveUserId = user?.userId || user_id || 'GUEST';

    if (!event_id) {
      connection.release();
      return apiResponse(400, { message: 'Requisição inválida (event_id obrigatório)' });
    }

    await connection.beginTransaction();

    let targetLotId = lot_id;
    let lotPrice = 0;
    let lotName = 'Lote Geral';

    // 1. Busca Lote do Evento
    if (targetLotId) {
      const [lotRow]: any = await connection.query(`SELECT * FROM event_lots WHERE id = ? FOR UPDATE;`, [targetLotId]);
      if (lotRow.length > 0) {
        const lot = lotRow[0];
        lotPrice = Number(lot.price) || 0;
        lotName = lot.name || 'Lote Geral';
        if (lot.available_capacity > 0) {
          await connection.query(`UPDATE event_lots SET available_capacity = available_capacity - 1 WHERE id = ?`, [targetLotId]);
        }
      }
    } else {
      const [lots]: any = await connection.query(`SELECT * FROM event_lots WHERE event_id = ? ORDER BY price ASC LIMIT 1 FOR UPDATE;`, [event_id]);
      if (lots.length > 0) {
        targetLotId = lots[0].id;
        lotPrice = Number(lots[0].price) || 0;
        lotName = lots[0].name || 'Lote Geral';
        if (lots[0].available_capacity > 0) {
          await connection.query(`UPDATE event_lots SET available_capacity = available_capacity - 1 WHERE id = ?`, [targetLotId]);
        }
      }
    }

    const [eventRow]: any = await connection.query(`SELECT * FROM events WHERE id = ?;`, [event_id]);
    const eventData = eventRow.length > 0 ? eventRow[0] : {};

    const shortCode = generateShortCode();
    const qrCodeToken = `TICKET-${uuidv4().substring(0, 8).toUpperCase()}-${Date.now()}`;
    const ticketId = uuidv4();
    const isFree = lotPrice === 0;
    const initialStatus = isFree ? 'PAID' : (payment_method === 'CREDIT_CARD' ? 'PAID' : 'PENDING');

    const qInsert = `
      INSERT INTO event_tickets (
        id, event_id, lot_id, user_id, organization_id, status, qrcode_token, short_code, price_paid,
        attendee_name, attendee_whatsapp, attendee_cpf, attendee_email, dietary_notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await connection.query(qInsert, [
      ticketId,
      event_id,
      targetLotId || 'lot_default',
      effectiveUserId,
      eventData.organization_id || user?.organizationId || 'org_default',
      initialStatus,
      qrCodeToken,
      shortCode,
      lotPrice,
      attendee_name || user?.name || null,
      attendee_whatsapp || null,
      attendee_cpf || null,
      attendee_email || user?.email || null,
      dietary_notes || null
    ]);

    await connection.commit();
    connection.release();

    return apiResponse(201, {
      message: 'Ingresso emitido com sucesso',
      ticket_id: ticketId,
      short_code: shortCode,
      status: initialStatus,
      qrcode_token: qrCodeToken,
      qr_code_data: qrCodeToken,
      price_paid: lotPrice,
      event_title: eventData.title || 'Evento Especial',
      event_date: eventData.start_date || null,
      event_location: eventData.location || 'Templo Principal',
      lot_name: lotName,
      attendee: {
        name: attendee_name || user?.name,
        whatsapp: attendee_whatsapp,
        cpf: attendee_cpf,
        email: attendee_email || user?.email,
        dietary_notes
      }
    });
  } catch (error: any) {
    await connection.rollback();
    connection.release();
    console.error('Erro no checkout de ingresso:', error);
    return apiResponse(500, { message: 'Erro na emissão do ingresso' });
  }
};

// GET /tickets/me?user_id=123
export const myTickets = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const userId = user?.userId || event.queryStringParameters?.user_id;
    const phone = event.queryStringParameters?.phone;
    const email = user?.email || event.queryStringParameters?.email;

    if (!userId && !phone && !email) {
      return apiResponse(400, { message: 'Identificação do participante obrigatória' });
    }

    let sql = `
      SELECT t.id, t.qrcode_token, t.short_code, t.status, t.price_paid, t.created_at, t.scanned_at, t.scanned_by,
             t.attendee_name, t.attendee_whatsapp, t.attendee_cpf, t.dietary_notes,
             e.id as event_id, e.title as event_title, e.start_date as event_date, e.location as event_location, 
             COALESCE(e.cover_url, e.image_url) as event_image,
             COALESCE(l.name, 'Geral') as lot_name
      FROM event_tickets t 
      JOIN events e ON t.event_id = e.id
      LEFT JOIN event_lots l ON t.lot_id = l.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (userId && phone && email) {
      sql += ` AND (t.user_id = ? OR t.attendee_whatsapp = ? OR t.attendee_email = ?)`;
      params.push(userId, phone, email);
    } else if (userId) {
      sql += ` AND (t.user_id = ? OR t.attendee_email = ?)`;
      params.push(userId, email || userId);
    } else if (phone) {
      sql += ` AND t.attendee_whatsapp = ?`;
      params.push(phone);
    } else if (email) {
      sql += ` AND t.attendee_email = ?`;
      params.push(email);
    }

    sql += ` ORDER BY t.created_at DESC;`;

    const { rows } = await query(sql, params);
    return apiResponse(200, { data: rows });
  } catch (err: any) {
    console.error('Erro ao buscar ingressos do membro:', err);
    return apiResponse(500, { error: 'Erro ao listar ingressos' });
  }
};

// POST /tickets/scan (PROTEGIDO: Apenas Portaria / Voluntários / Líderes Autorizados)
export const scanTicket = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const connection = await getConnection();
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) {
      connection.release();
      return auth.errorResponse;
    }

    const roleCheck = enforceRole(auth.user, SCANNER_ROLES);
    if (!roleCheck.allowed) {
      connection.release();
      return roleCheck.errorResponse!;
    }

    const body = JSON.parse(event.body || '{}');
    const { token, scanned_by } = body;

    const trimmedToken = (token || '').trim();
    if (!trimmedToken) {
      connection.release();
      return apiResponse(400, { isValid: false, message: 'Token ou Código de Ingresso Ausente' });
    }

    await connection.beginTransaction();
    
    const [ticketRow]: any = await connection.query(
      `SELECT t.*, e.title as event_title, e.start_date as event_date, e.location as event_location, e.organization_id,
              COALESCE(l.name, 'Geral') as lot_name 
       FROM event_tickets t 
       JOIN events e ON t.event_id = e.id 
       LEFT JOIN event_lots l ON t.lot_id = l.id 
       WHERE t.qrcode_token = ? OR UPPER(t.short_code) = UPPER(?) OR t.id = ? FOR UPDATE;`,
      [trimmedToken, trimmedToken, trimmedToken]
    );

    if (ticketRow.length === 0) {
      await connection.rollback();
      connection.release();
      return apiResponse(404, {
        isValid: false,
        message: '❌ Ingresso NÃO ENCONTRADO ou Inválido!'
      });
    }

    const ticket = ticketRow[0];

    if (ticket.status === 'USED') {
      await connection.rollback();
      connection.release();
      const usedTime = ticket.scanned_at ? new Date(ticket.scanned_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'horário anterior';
      return apiResponse(400, {
        isValid: false,
        isUsed: true,
        message: `⚠️ Este ingresso JÁ FOI UTILIZADO às ${usedTime}!`,
        attendee_name: ticket.attendee_name || 'Participante',
        event: ticket.event_title,
        lot: ticket.lot_name,
        scanned_at: ticket.scanned_at,
        scanned_by: ticket.scanned_by
      });
    }

    if (ticket.status === 'PENDING') {
      await connection.rollback();
      connection.release();
      return apiResponse(400, {
        isValid: false,
        isPending: true,
        message: '⚠️ Pagamento do ingresso ainda PENDENTE de aprovação!',
        attendee_name: ticket.attendee_name || 'Participante',
        event: ticket.event_title,
        lot: ticket.lot_name
      });
    }

    const validatorName = scanned_by || auth.user.name || auth.user.email || 'Portaria';
    await connection.query(
      `UPDATE event_tickets SET status = 'USED', scanned_at = NOW(), scanned_by = ? WHERE id = ?`,
      [validatorName, ticket.id]
    );

    const [countRows]: any = await connection.query(
      `SELECT 
        COUNT(*) as total_tickets,
        SUM(CASE WHEN status = 'USED' THEN 1 ELSE 0 END) as total_present
       FROM event_tickets WHERE event_id = ?`,
      [ticket.event_id]
    );
    const stats = countRows[0] || { total_tickets: 1, total_present: 1 };

    await connection.commit();
    connection.release();

    await logSecurityEvent({
      organizationId: ticket.organization_id || auth.user.organizationId,
      user: auth.user,
      action: 'SCAN_EVENT_TICKET',
      resource: 'event_tickets',
      resourceId: ticket.id,
      details: { attendee_name: ticket.attendee_name, event_title: ticket.event_title },
      event
    });

    return apiResponse(200, {
      isValid: true,
      message: '✅ Check-in Concluído com Sucesso! Entrada Liberada.',
      ticket_id: ticket.id,
      short_code: ticket.short_code,
      attendee_name: ticket.attendee_name || 'Participante',
      attendee_whatsapp: ticket.attendee_whatsapp,
      event: ticket.event_title,
      lot: ticket.lot_name,
      scanned_at: new Date(),
      scanned_by: validatorName,
      stats: {
        total_tickets: Number(stats.total_tickets) || 0,
        total_present: Number(stats.total_present) || 0
      }
    });
  } catch (err: any) {
    await connection.rollback();
    connection.release();
    console.error('Erro no scanTicket:', err);
    return apiResponse(500, { message: 'Falha no Scanner' });
  }
};
