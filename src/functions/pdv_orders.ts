import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';

// POST /pdv/orders
export const createOrder = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const userId = (event.requestContext as any)?.authorizer?.jwt?.claims?.sub || 'GUEST';
    const body = JSON.parse(event.body || '{}');
    const {
      user_name,
      customer_phone,
      delivery_method,
      delivery_details,
      items_json,
      total_price,
      payment_method,
      payment_status
    } = body;

    if (!user_name || !items_json) {
      return apiResponse(400, { message: 'Dados incompletos: nome do cliente e itens são obrigatórios.' });
    }

    const orderId = uuidv4();
    const itemsString = typeof items_json === 'string' ? items_json : JSON.stringify(items_json);
    const finalPhone = customer_phone || '';
    const finalMethod = payment_method || (delivery_details?.includes('CREDIT_CARD') ? 'CREDIT_CARD' : 'PIX');
    const finalPayStatus = payment_status || (finalMethod === 'CREDIT_CARD' ? 'PAID' : 'PENDING');

    const sql = `
      INSERT INTO pdv_orders 
        (id, user_id, user_name, customer_phone, status, payment_method, payment_status, delivery_method, delivery_details, items_json, total_price) 
      VALUES (?, ?, ?, ?, 'RECEBIDO', ?, ?, ?, ?, ?, ?)
    `;

    await query(sql, [
      orderId,
      userId,
      user_name,
      finalPhone,
      finalMethod,
      finalPayStatus,
      delivery_method || 'church',
      delivery_details || '',
      itemsString,
      total_price || 0.00
    ]);

    return apiResponse(201, {
      message: 'Pedido criado com sucesso',
      id: orderId,
      status: 'RECEBIDO',
      payment_status: finalPayStatus
    });
  } catch (error: any) {
    console.error('Erro criando pedido:', error);
    return apiResponse(500, { message: 'Erro no servidor ao criar pedido', error: error.message });
  }
};

// GET /pdv/orders
export const getOrders = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const status = event.queryStringParameters?.status;
    const paymentStatus = event.queryStringParameters?.payment_status;
    const userId = event.queryStringParameters?.user_id;

    let sql = 'SELECT * FROM pdv_orders WHERE 1=1';
    const params: any[] = [];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    if (paymentStatus) {
      sql += ' AND payment_status = ?';
      params.push(paymentStatus);
    }

    if (userId) {
      sql += ' AND user_id = ?';
      params.push(userId);
    }

    sql += ' ORDER BY created_at DESC LIMIT 100';

    const { rows } = await query(sql, params);

    const formatted = rows.map((r: any) => ({
      ...r,
      items_json: typeof r.items_json === 'string' ? JSON.parse(r.items_json || '[]') : r.items_json,
      total_price: Number(r.total_price) || 0
    }));

    return apiResponse(200, formatted);
  } catch (error: any) {
    console.error('Erro listando pedidos:', error);
    return apiResponse(500, { message: 'Erro ao listar pedidos', error: error.message });
  }
};

// PUT /pdv/orders/{id}/status
export const updateOrderStatus = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { message: 'ID ausente' });

    const body = JSON.parse(event.body || '{}');
    const { status, payment_status } = body;

    let updateFields: string[] = [];
    let params: any[] = [];

    if (status) {
      updateFields.push('status = ?');
      params.push(status);
    }

    if (payment_status) {
      updateFields.push('payment_status = ?');
      params.push(payment_status);
    }

    if (updateFields.length === 0) {
      return apiResponse(400, { message: 'Nenhum campo para atualizar (status ou payment_status)' });
    }

    params.push(id);
    const sql = `UPDATE pdv_orders SET ${updateFields.join(', ')}, updated_at = NOW() WHERE id = ?`;

    await query(sql, params);

    return apiResponse(200, { message: 'Status do pedido atualizado com sucesso', id });
  } catch (error: any) {
    console.error('Erro atualizando pedido:', error);
    return apiResponse(500, { message: 'Erro ao atualizar pedido', error: error.message });
  }
};
