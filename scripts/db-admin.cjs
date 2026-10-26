const mysql = require('mysql2/promise');
const { ca } = require('aws-ssl-profiles');
const { GetSecretValueCommand, SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');

async function loadAdminCredentials() {
  const secretArn = process.env.DB_ADMIN_SECRET_ARN;
  if (secretArn) {
    const region = process.env.DB_ADMIN_SECRET_REGION || 'us-east-1';
    const response = await new SecretsManagerClient({ region }).send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!response.SecretString) throw new Error('DB_ADMIN_SECRET_EMPTY');
    const secret = JSON.parse(response.SecretString);
    if (!secret.username || !secret.password) throw new Error('DB_ADMIN_SECRET_INVALID');
    return { user: secret.username, password: secret.password };
  }
  if (!process.env.DB_USER || !process.env.DB_PASSWORD) throw new Error('DB_ADMIN_SECRET_ARN_REQUIRED');
  return { user: process.env.DB_USER, password: process.env.DB_PASSWORD };
}

async function createAdminConnection() {
  const credentials = await loadAdminCredentials();
  return mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: credentials.user,
    password: credentials.password,
    database: process.env.DB_NAME || 'faith-hub',
    connectTimeout: 10000,
    ssl: process.env.DB_SSL === 'require' ? { ca, rejectUnauthorized: true } : undefined
  });
}

module.exports = { createAdminConnection };
