import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, getConnection, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';
import { checkRateLimit } from '../services/rateLimiter';

const SCANNER_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'TREASURER', 'LEADER', 'VOLUNTEER'];

// Gerador de Código Curto de Validação Manual (ex: FH-784291)
const generateShortCode = (): string => {
  const num = Math.floor(100000 + Math.random() * 900000);
  return `FH-${num}`;
};

// POST /tickets/checkout — public registration, all prices and settlement are server-owned.
export const checkout = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const rateCheck = await checkRateLimit(event, { maxRequests: 20, windowSeconds: 60, identifierPrefix: 'ticket_checkout' });
  if (!rateCheck.allowed) return rateCheck.errorResponse!;
  const user = await getAuthenticatedUser(event);
  const body = JSON.parse(event.body || '{}');
  const orgId = body.organization_id || user?.organizationId;
  if (!body.event_id || !orgId) return apiResponse(400, { message: 'Evento e organização são obrigatórios.' });
  if (body.payment_method && body.payment_method !== 'PIX') return apiResponse(409, { message: 'Pagamento por cartão indisponível. Utilize Pix.' });
  if (user) {
    const tenantCheck = enforceTenant(user, orgId);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
  }
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    const [events]: any = await connection.query(`SELECT * FROM events WHERE id = ? AND organization_id = ? AND status = 'PUBLISHED'`, [body.event_id, orgId]);
    if (!events.length) { await connection.rollback(); return apiResponse(404, { message: 'Evento indisponível.' }); }
    const eventData = events[0];
    const [lots]: any = await connection.query(
      `SELECT l.* FROM event_lots l INNER JOIN events e ON e.id = l.event_id
       WHERE l.event_id = ? AND e.organization_id = ? AND (? IS NULL OR l.id = ?)
         AND (l.sales_start_date IS NULL OR l.sales_start_date <= NOW())
         AND (l.sales_end_date IS NULL OR l.sales_end_date >= NOW())
       ORDER BY l.price ASC LIMIT 1 FOR UPDATE`, [body.event_id, orgId, body.lot_id || null, body.lot_id || null]);
    if (!lots.length || lots[0].available_capacity <= 0) { await connection.rollback(); return apiResponse(409, { message: 'Lote indisponível ou esgotado.' }); }
    const lot = lots[0];
    const price = Number(lot.price);
    if (!Number.isFinite(price) || price < 0) { await connection.rollback(); return apiResponse(409, { message: 'Preço do lote inválido.' }); }
    await connection.query(`UPDATE event_lots l INNER JOIN events e ON e.id = l.event_id SET l.available_capacity = l.available_capacity - 1 WHERE l.id = ? AND e.organization_id = ? AND l.available_capacity > 0`, [lot.id, orgId]);
    const ticketId = uuidv4();
    const qrCodeToken = `TICKET-${uuidv4()}`;
    const shortCode = generateShortCode();
    const status = price === 0 ? 'PAID' : 'PENDING';
    await connection.query(`INSERT INTO event_tickets
      (id, event_id, lot_id, user_id, organization_id, status, qrcode_token, short_code, price_paid, attendee_name, attendee_whatsapp, attendee_cpf, attendee_email, dietary_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ticketId, eventData.id, lot.id, user?.userId || 'GUEST', orgId, status, qrCodeToken, shortCode, price,
       body.attendee_name || user?.name || null, body.attendee_whatsapp || null, body.attendee_cpf || null,
       user?.email || body.attendee_email || null, body.dietary_notes || null]);
    await connection.commit();
    await logSecurityEvent({ organizationId: orgId, user, action: 'CREATE_EVENT_TICKET', resource: 'event_tickets', resourceId: ticketId, details: { status, amount: price, event_id: eventData.id }, event });
    return apiResponse(201, { ticket_id: ticketId, short_code: shortCode, qrcode_token: qrCodeToken, qr_code_data: qrCodeToken,
      status, price_paid: price, event_title: eventData.title, event_date: eventData.start_date, event_location: eventData.location, lot_name: lot.name });
  } catch (error) {
    await connection.rollback();
    console.error('Erro no checkout:', error);
    return apiResponse(500, { message: 'Erro na emissão do ingresso' });
  } finally { connection.release(); }
};

export const myTickets = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const auth = await requireAuth(event);
  if ('errorResponse' in auth) return auth.errorResponse;
  const tenantCheck = enforceTenant(auth.user, event.queryStringParameters?.organization_id);
  if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
  const { rows } = await query(`SELECT t.*, e.title as event_title, e.start_date as event_date, e.location as event_location,
    COALESCE(e.cover_url, e.image_url) as event_image, l.name as lot_name
    FROM event_tickets t JOIN events e ON e.id = t.event_id LEFT JOIN event_lots l ON l.id = t.lot_id
    WHERE t.organization_id = ? AND e.organization_id = ? AND t.user_id = ? ORDER BY t.created_at DESC`,
    [tenantCheck.effectiveOrgId, tenantCheck.effectiveOrgId, auth.user.userId]);
  return apiResponse(200, { data: rows });
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

    const tenantCheck = enforceTenant(auth.user, body.organization_id || event.headers?.['x-organization-id']);
    if (!tenantCheck.allowed) { connection.release(); return tenantCheck.errorResponse!; }
    await connection.beginTransaction();
    const [ticketRow]: any = await connection.query(
      `SELECT t.*, e.title as event_title, e.start_date as event_date, e.location as event_location, e.organization_id,
              COALESCE(l.name, 'Geral') as lot_name 
       FROM event_tickets t 
       JOIN events e ON t.event_id = e.id 
       LEFT JOIN event_lots l ON t.lot_id = l.id 
       WHERE t.organization_id = ? AND e.organization_id = ? AND (t.qrcode_token = ? OR UPPER(t.short_code) = UPPER(?) OR t.id = ?) FOR UPDATE;`,
      [tenantCheck.effectiveOrgId, tenantCheck.effectiveOrgId, trimmedToken, trimmedToken, trimmedToken]
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

    if (ticket.status !== 'PAID') {
      await connection.rollback(); connection.release();
      return apiResponse(409, { isValid: false, message: 'Ingresso não está liberado para entrada.' });
    }
    const validatorName = auth.user.name || auth.user.email || 'Portaria';
    await connection.query(
      `UPDATE event_tickets SET status = 'USED', scanned_at = NOW(), scanned_by = ? WHERE id = ? AND organization_id = ? AND status = 'PAID'`,
      [validatorName, ticket.id, tenantCheck.effectiveOrgId]
    );

    const [countRows]: any = await connection.query(
      `SELECT 
        COUNT(*) as total_tickets,
        SUM(CASE WHEN status = 'USED' THEN 1 ELSE 0 END) as total_present
       FROM event_tickets WHERE event_id = ? AND organization_id = ?`,
      [ticket.event_id, tenantCheck.effectiveOrgId]
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

// GET /tickets/{id}/pass (Dados estruturados para Passaporte / Carteira Digital)
export const getTicketPass = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;
    const tenantCheck = enforceTenant(auth.user, event.queryStringParameters?.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID do ingresso obrigatório' });

    const { rows } = await query(
      `SELECT t.*, e.title as event_title, e.description as event_description, 
              e.start_date as event_date, e.location as event_location, 
              COALESCE(e.cover_url, e.image_url) as event_image,
              COALESCE(l.name, 'Geral') as lot_name,
              o.name as organization_name
       FROM event_tickets t
       JOIN events e ON t.event_id = e.id
       LEFT JOIN event_lots l ON t.lot_id = l.id
       LEFT JOIN organizations o ON t.organization_id = o.id
       WHERE t.organization_id = ? AND e.organization_id = ? AND t.user_id = ? AND (t.id = ? OR t.qrcode_token = ?) LIMIT 1`,
      [tenantCheck.effectiveOrgId, tenantCheck.effectiveOrgId, auth.user.userId, id, id]
    );

    if (rows.length === 0) {
      return apiResponse(404, { message: 'Ingresso não encontrado' });
    }

    const ticket = rows[0];
    const startDate = ticket.event_date ? new Date(ticket.event_date) : new Date();
    const endDate = new Date(startDate.getTime() + 3 * 60 * 60 * 1000); // Duração estimada 3h
    const formatDateForCal = (d: Date) => d.toISOString().replace(/-|:|\.\d\d\d/g, "");

    const googleCalendarUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(ticket.event_title)}&dates=${formatDateForCal(startDate)}/${formatDateForCal(endDate)}&details=${encodeURIComponent(`Ingresso: ${ticket.short_code}\nTitular: ${ticket.attendee_name || 'Participante'}\nLote: ${ticket.lot_name}`)}&location=${encodeURIComponent(ticket.event_location || 'Templo Principal')}`;

    return apiResponse(200, {
      data: {
        ...ticket,
        google_calendar_url: googleCalendarUrl,
        apple_wallet_available: true,
        google_wallet_available: true,
        calendar_download_url: `/tickets/${ticket.id}/calendar.ics`
      }
    });
  } catch (err: any) {
    console.error('Erro ao buscar dados do passaporte:', err);
    return apiResponse(500, { message: 'Erro ao gerar passaporte' });
  }
};

// GET /tickets/{id}/calendar.ics (Download de arquivo iCalendar para Apple / Android)
export const getTicketCalendar = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;
    const tenantCheck = enforceTenant(auth.user, event.queryStringParameters?.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID do ingresso obrigatório' });

    const { rows } = await query(
      `SELECT t.*, e.title as event_title, e.description as event_description, 
              e.start_date as event_date, e.location as event_location
       FROM event_tickets t
       JOIN events e ON t.event_id = e.id
       WHERE t.organization_id = ? AND e.organization_id = ? AND t.user_id = ? AND (t.id = ? OR t.qrcode_token = ?) LIMIT 1`,
      [tenantCheck.effectiveOrgId, tenantCheck.effectiveOrgId, auth.user.userId, id, id]
    );

    if (rows.length === 0) {
      return apiResponse(404, { message: 'Ingresso não encontrado' });
    }

    const ticket = rows[0];
    const startDate = ticket.event_date ? new Date(ticket.event_date) : new Date();
    const endDate = new Date(startDate.getTime() + 3 * 60 * 60 * 1000);
    const formatDateForCal = (d: Date) => d.toISOString().replace(/-|:|\.\d\d\d/g, "");

    const icsContent = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Faith-Hub//Event Tickets//PT',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${ticket.id}@faithhub.app`,
      `DTSTAMP:${formatDateForCal(new Date())}`,
      `DTSTART:${formatDateForCal(startDate)}`,
      `DTEND:${formatDateForCal(endDate)}`,
      `SUMMARY:${ticket.event_title}`,
      `DESCRIPTION:Ingresso ${ticket.short_code} - Titular: ${ticket.attendee_name || 'Participante'}`,
      `LOCATION:${ticket.event_location || 'Templo Principal'}`,
      'STATUS:CONFIRMED',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="ingresso-${ticket.short_code || 'evento'}.ics"`,
        'Access-Control-Allow-Origin': '*'
      },
      body: icsContent
    };
  } catch (err: any) {
    console.error('Erro ao gerar arquivo ICS:', err);
    return apiResponse(500, { message: 'Erro ao gerar arquivo de calendário' });
  }
};

