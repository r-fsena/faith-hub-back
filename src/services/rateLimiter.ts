import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { apiResponse } from '../db';

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

// In-memory cache for warm Lambda executions
const rateLimitCache = new Map<string, RateLimitRecord>();

// Clean up expired keys periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitCache.entries()) {
    if (record.resetAt <= now) {
      rateLimitCache.delete(key);
    }
  }
}, 300000);

export interface RateLimitOptions {
  maxRequests: number;     // e.g. 20 requests
  windowSeconds: number;   // e.g. 60 seconds (1 minute)
  identifierPrefix?: string;
}

/**
 * Checks and enforces rate limit per IP or Identifier
 */
export function checkRateLimit(
  event: APIGatewayProxyEvent,
  options: RateLimitOptions
): { allowed: boolean; remaining: number; errorResponse?: APIGatewayProxyResult } {
  const ipAddress =
    event.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
    event.requestContext?.identity?.sourceIp ||
    (event.requestContext as any)?.http?.sourceIp ||
    'anonymous_ip';

  const prefix = options.identifierPrefix || 'global';
  const key = `${prefix}:${ipAddress}`;
  const now = Date.now();
  const windowMs = options.windowSeconds * 1000;

  const current = rateLimitCache.get(key);

  if (!current || current.resetAt <= now) {
    rateLimitCache.set(key, {
      count: 1,
      resetAt: now + windowMs
    });

    return {
      allowed: true,
      remaining: options.maxRequests - 1
    };
  }

  if (current.count >= options.maxRequests) {
    const retryAfterSec = Math.ceil((current.resetAt - now) / 1000);
    console.warn(`[RATE LIMIT EXCEEDED] IP ${ipAddress} bloqueado no endpoint '${prefix}'. Tentativas: ${current.count}/${options.maxRequests}`);

    return {
      allowed: false,
      remaining: 0,
      errorResponse: {
        statusCode: 429,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Retry-After': String(retryAfterSec)
        },
        body: JSON.stringify({
          error: 'RATE_LIMIT_EXCEEDED',
          message: `Limite de requisições excedido. Por favor, aguarde ${retryAfterSec} segundos antes de tentar novamente.`,
          retryAfter: retryAfterSec
        })
      }
    };
  }

  current.count += 1;

  return {
    allowed: true,
    remaining: options.maxRequests - current.count
  };
}
