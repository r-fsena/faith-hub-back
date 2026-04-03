import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'faith-hub',
  ssl: { rejectUnauthorized: false },
});

// Middleware para Headers de CORS
const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': true,
};

export const createOrder = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const userId = event.requestContext.authorizer?.jwt?.claims?.sub || 'GUEST';
    // Se o user_id for resgatado de cognito, nós precisamos do nome. A aplicação vai mandar.
    const body = JSON.parse(event.body || '{}');
    const { user_name, delivery_method, delivery_details, items_json, total_price } = body;

    if (!user_name || !items_json) {
       return { statusCode: 400, headers, body: JSON.stringify({ message: "Dados incompletos" }) };
    }

    const orderId = uuidv4();
    const itemsString = typeof items_json === 'string' ? items_json : JSON.stringify(items_json);

    await pool.query(
      `INSERT INTO pdv_orders 
        (id, user_id, user_name, delivery_method, delivery_details, items_json, total_price) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [orderId, userId, user_name, delivery_method, delivery_details, itemsString, total_price]
    );

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({ message: "Pedido criado com sucesso", id: orderId }),
    };
  } catch (error) {
    console.error("Erro criando pedido:", error);
    return { statusCode: 500, headers, body: JSON.stringify({ message: "Erro no servidor" }) };
  }
};

export const getOrders = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const status = event.queryStringParameters?.status;
    let query = "SELECT * FROM pdv_orders";
    let params: any[] = [];
    
    if (status) {
       query += " WHERE status = ?";
       params.push(status);
    }
    
    query += " ORDER BY created_at DESC LIMIT 100";
    
    const [rows] = await pool.query(query, params);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(rows),
    };
  } catch (error) {
    console.error("Erro listando pedidos:", error);
    return { statusCode: 500, headers, body: JSON.stringify({ message: "Erro no servidor" }) };
  }
};

export const updateOrderStatus = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ message: "Sem ID" }) };

    const body = JSON.parse(event.body || '{}');
    const { status } = body;

    const [result] = await pool.query(
      "UPDATE pdv_orders SET status = ? WHERE id = ?",
      [status, id]
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ message: "Status atualizado", id }),
    };
  } catch (error) {
    console.error("Erro atualizando pedido:", error);
    return { statusCode: 500, headers, body: JSON.stringify({ message: "Erro no servidor" }) };
  }
};
