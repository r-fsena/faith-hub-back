import { createHash } from 'crypto';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

interface RateLimitRecord { count: number; resetAt: number; }

const rateLimitCache = new Map<string, RateLimitRecord>();
const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-2' });

setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitCache.entries()) {
    if (record.resetAt <= now) rateLimitCache.delete(key);
  }
}, 300000).unref();

export interface RateLimitOptions {
  maxRequests: number;
  windowSeconds: number;
  identifierPrefix?: string;
}

function requestIp(event: APIGatewayProxyEvent): string {
  return (event.requestContext as any)?.http?.sourceIp
    || event.requestContext?.identity?.sourceIp
    || event.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || event.headers?.['X-Forwarded-For']?.split(',')[0]?.trim()
    || 'anonymous_ip';
}

function hashedKey(event: APIGatewayProxyEvent, prefix: string): string {
  return `${prefix}:${createHash('sha256').update(requestIp(event)).digest('hex')}`;
}

function localIncrement(key: string, windowMs: number): RateLimitRecord {
  const now = Date.now();
  const current = rateLimitCache.get(key);
  if (!current || current.resetAt <= now) {
    const created = { count: 1, resetAt: now + windowMs };
    rateLimitCache.set(key, created);
    return created;
  }
  current.count += 1;
  return current;
}

async function distributedIncrement(tableName: string, key: string, windowMs: number, attempt = 0): Promise<RateLimitRecord> {
  const now = Date.now();
  const resetAt = now + windowMs;
  const expiresAt = Math.ceil(resetAt / 1000) + 60;
  try {
    const response = await dynamo.send(new UpdateItemCommand({
      TableName: tableName,
      Key: { rate_key: { S: key } },
      UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :one, reset_at = if_not_exists(reset_at, :reset), expires_at = :expires',
      ConditionExpression: 'attribute_not_exists(reset_at) OR reset_at > :now',
      ExpressionAttributeNames: { '#count': 'request_count' },
      ExpressionAttributeValues: {
        ':zero': { N: '0' }, ':one': { N: '1' }, ':reset': { N: String(resetAt) },
        ':expires': { N: String(expiresAt) }, ':now': { N: String(now) }
      },
      ReturnValues: 'ALL_NEW'
    }));
    return { count: Number(response.Attributes?.request_count?.N || 1), resetAt: Number(response.Attributes?.reset_at?.N || resetAt) };
  } catch (error: any) {
    if (error?.name !== 'ConditionalCheckFailedException') throw error;
    try {
      const response = await dynamo.send(new UpdateItemCommand({
        TableName: tableName,
        Key: { rate_key: { S: key } },
        UpdateExpression: 'SET #count = :one, reset_at = :reset, expires_at = :expires',
        ConditionExpression: 'reset_at <= :now',
        ExpressionAttributeNames: { '#count': 'request_count' },
        ExpressionAttributeValues: {
          ':one': { N: '1' }, ':reset': { N: String(resetAt) },
          ':expires': { N: String(expiresAt) }, ':now': { N: String(now) }
        },
        ReturnValues: 'ALL_NEW'
      }));
      return { count: 1, resetAt: Number(response.Attributes?.reset_at?.N || resetAt) };
    } catch (resetError: any) {
      if (resetError?.name === 'ConditionalCheckFailedException' && attempt < 2) return distributedIncrement(tableName, key, windowMs, attempt + 1);
      throw resetError;
    }
  }
}

function limitedResponse(resetAt: number): APIGatewayProxyResult {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return {
    statusCode: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) },
    body: JSON.stringify({ error: 'RATE_LIMIT_EXCEEDED', message: `Limite de requisições excedido. Aguarde ${retryAfter} segundos.`, retryAfter })
  };
}

export async function checkRateLimit(
  event: APIGatewayProxyEvent,
  options: RateLimitOptions
): Promise<{ allowed: boolean; remaining: number; errorResponse?: APIGatewayProxyResult }> {
  const prefix = options.identifierPrefix || 'global';
  const key = hashedKey(event, prefix);
  const windowMs = options.windowSeconds * 1000;
  try {
    const record = process.env.RATE_LIMIT_TABLE
      ? await distributedIncrement(process.env.RATE_LIMIT_TABLE, key, windowMs)
      : localIncrement(key, windowMs);
    const allowed = record.count <= options.maxRequests;
    return { allowed, remaining: Math.max(0, options.maxRequests - record.count), errorResponse: allowed ? undefined : limitedResponse(record.resetAt) };
  } catch (error) {
    console.error('[RATE_LIMIT_UNAVAILABLE]', { prefix, error: error instanceof Error ? error.name : 'unknown' });
    return {
      allowed: false,
      remaining: 0,
      errorResponse: {
        statusCode: 503,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'RATE_LIMIT_UNAVAILABLE', message: 'Proteção temporariamente indisponível. Tente novamente.' })
      }
    };
  }
}
