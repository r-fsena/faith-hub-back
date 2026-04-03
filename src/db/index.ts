import mysql from 'mysql2/promise';

export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  // Força o SSL ignorando CRLF (enters do Windows no final do arquivo .env)
  ssl: { rejectUnauthorized: false }
});

// Mantivemos o nome "query" e o retorno "{ rows }" para minimizar impactos
export const query = async (text: string, params?: any[]) => {
  const [rows] = await pool.execute(text, params);
  return { rows: rows as any[] };
};
