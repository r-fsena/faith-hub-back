import mysql, { Pool, PoolOptions } from 'mysql2/promise';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ca } from 'aws-ssl-profiles';

interface DatabaseSecret {
  host?: string;
  port?: number | string;
  username?: string;
  user?: string;
  password?: string;
  dbname?: string;
  database?: string;
}

let poolPromise: Promise<Pool> | undefined;
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-2' });

async function loadDatabaseConfig(): Promise<PoolOptions> {
  const secretArn = process.env.DB_SECRET_ARN;
  let secret: DatabaseSecret = {};

  if (secretArn) {
    const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!response.SecretString) throw new Error('DB_SECRET_EMPTY');
    try {
      secret = JSON.parse(response.SecretString);
    } catch {
      throw new Error('DB_SECRET_INVALID_JSON');
    }
  } else if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    throw new Error('DB_SECRET_ARN_REQUIRED');
  }

  const host = secret.host || process.env.DB_HOST || 'localhost';
  const user = secret.username || secret.user || process.env.DB_USER || 'root';
  const password = secret.password ?? process.env.DB_PASSWORD ?? '';
  const database = secret.dbname || secret.database || (process.env.DB_NAME !== 'null' ? process.env.DB_NAME : undefined) || 'faith-hub';
  const port = Number(secret.port || process.env.DB_PORT || 3306);

  if (!host || !user || !password || !database || !Number.isInteger(port)) {
    throw new Error('DB_CONFIG_INCOMPLETE');
  }

  return {
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    ssl: process.env.DB_SSL === 'require' ? { ca, rejectUnauthorized: true } : undefined
  };
}

export async function getPool(): Promise<Pool> {
  if (!poolPromise) {
    poolPromise = loadDatabaseConfig().then(config => mysql.createPool(config)).catch(error => {
      poolPromise = undefined;
      throw error;
    });
  }
  return poolPromise;
}

export const query = async (text: string, params?: any[]) => {
  const pool = await getPool();
  const [rows] = await pool.query(text, params);
  return { rows: rows as any[] };
};

export const getConnection = async () => {
  const pool = await getPool();
  return pool.getConnection();
};

export async function closePool(): Promise<void> {
  if (!poolPromise) return;
  const pool = await poolPromise;
  poolPromise = undefined;
  await pool.end();
}

export const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'OPTIONS,GET,POST,PUT,PATCH,DELETE',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,x-organization-id,x-campus-id',
};

export function apiResponse(statusCode: number, body: any, customHeaders?: Record<string, any>) {
  return {
    statusCode,
    headers: { ...corsHeaders, ...customHeaders },
    body: JSON.stringify(body),
  };
}
