import mysql from 'mysql2/promise';

export const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'faith-hub',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  ssl: { rejectUnauthorized: false }
});

export const query = async (text: string, params?: any[]) => {
  const [rows] = await pool.query(text, params);
  return { rows: rows as any[] };
};

export const getConnection = async () => {
  return await pool.getConnection();
};

export const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'OPTIONS,GET,POST,PUT,DELETE',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Credentials': true,
};

export function apiResponse(statusCode: number, body: any, customHeaders?: Record<string, any>) {
  return {
    statusCode,
    headers: { ...corsHeaders, ...customHeaders },
    body: JSON.stringify(body),
  };
}
