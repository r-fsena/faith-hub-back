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

// POST /tickets/checkout
export const checkout = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const connection = await getConnection();
  try {
    const body = JSON.parse(event.body || '{}');
    const { event_id, lot_id, user_id } = body;

    if (!event_id || !lot_id || !user_id) {
      await connection.end();
      return response(400, { message: 'Requisição inválida (event_id, lot_id, user_id)' });
    }

    // Para evitar Race Condition (Venda Estourada/Double Booking), iniciamos uma Transação
    await connection.beginTransaction();

    // Bloqueia a linha do Lote para Leitura e Escrita Síncrona FOR UPDATE (Pessimistic Lock)
    const [lotRow]: any = await connection.query(`SELECT * FROM event_lots WHERE id = ? FOR UPDATE;`, [lot_id]);
    
    if (lotRow.length === 0) {
      await connection.rollback();
      await connection.end();
      return response(404, { message: 'Lote não existe' });
    }

    const lot = lotRow[0];

    // Checa Capacidade/Disponibilidade do Lote
    if (lot.available_capacity <= 0) {
      await connection.rollback();
      await connection.end();
      return response(400, { message: 'Ingressos esgotados neste Lote!' });
    }

    // Checa se o usuário já tem um ingresso para este evento? Opcional
    // Se a igreja permitir N ingressos, não barramos. 

    // Diminui o estoque
    await connection.query(`UPDATE event_lots SET available_capacity = available_capacity - 1 WHERE id = ?`, [lot_id]);

    // O Token é uma Assinatura Segura q representará o código visual no App
    const qrCodeToken = `TICKET-${uuidv4()}-${Date.now()}`;
    const ticketId = uuidv4();

    // Insere Ingressos
    const qInsert = `
      INSERT INTO event_tickets (id, event_id, lot_id, user_id, status, qrcode_token, price_paid)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    
    const initialStatus = lot.price > 0 ? 'PENDING' : 'PAID';

    await connection.query(qInsert, [ticketId, event_id, lot_id, user_id, initialStatus, qrCodeToken, lot.price]);

    // Commit da transação segura e liberação do DB
    await connection.commit();
    await connection.end();

    return response(201, {
      message: 'Ingresso reservado com sucesso',
      ticket: {
        id: ticketId,
        qrcode_token: qrCodeToken,
        status: initialStatus,
        price: lot.price
      }
    });
  } catch (error: any) {
    await connection.rollback();
    console.error('Error in Checkout:', error);
    await connection.end();
    return response(500, { message: 'Erro na emissão do ingresso', error: error.message });
  }
};

// GET /tickets/me?user_id=123
export const myTickets = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const userId = event.queryStringParameters?.user_id;
    if (!userId) return response(400, { message: 'user_id param obrigatório' });

    const connection = await getConnection();
    
    // Traz o ingresso + Informações do Evento Associado
    const query = `
      SELECT t.id, t.qrcode_token, t.status, t.price_paid, e.title as event_title, e.start_date as event_date, e.location as event_location, e.image_url as event_image, l.name as lot_name
      FROM event_tickets t 
      JOIN events e ON t.event_id = e.id
      JOIN event_lots l ON t.lot_id = l.id
      WHERE t.user_id = ? 
      ORDER BY t.created_at DESC;
    `;
    
    const [rows]: any = await connection.query(query, [userId]);
    await connection.end();

    return response(200, { data: rows });
  } catch (err: any) {
    return response(500, { error: err.message });
  }
};

// POST /tickets/scan
// Chamado Pelo Líder via Câmera Escaneando o QR Code na porta
export const scanTicket = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { token } = body;
    
    if (!token) return response(400, { isValid: false, message: 'Token de QR Code Ausente' });

    const connection = await getConnection();
    
    // Busca e Trava
    await connection.beginTransaction();
    const [ticketRow]: any = await connection.query(`SELECT status FROM event_tickets WHERE qrcode_token = ? FOR UPDATE;`, [token]);
    
    if (ticketRow.length === 0) {
      await connection.rollback();
      await connection.end();
      return response(404, { isValid: false, message: 'Ingresso Inválido ou Falso!' });
    }

    const ticket = ticketRow[0];

    if (ticket.status === 'USED') {
      await connection.rollback();
      await connection.end();
      return response(400, { isValid: false, message: '⚠️ Este ingresso JÁ FOI UTILIZADO e escaneado!' });
    }

    if (ticket.status === 'PENDING') {
      await connection.rollback();
      await connection.end();
      return response(400, { isValid: false, message: 'Ingresso ainda Pendente de Pagamento!' });
    }

    // Se estiver PAID, então libera e marca como Usado (SCANNED)
    await connection.query(`UPDATE event_tickets SET status = 'USED', scanned_at = NOW() WHERE qrcode_token = ?`, [token]);
    
    await connection.commit();
    await connection.end();

    return response(200, { isValid: true, message: '✅ Check-in Concluído com Sucesso! Acesso Liberado.' });
  } catch (err: any) {
    return response(500, { message: 'Falha Fatal do Scanner', error: err.message });
  }
};
