import { APIGatewayProxyEvent } from 'aws-lambda';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';

let verifier: { issuer: string; keys: ReturnType<typeof createRemoteJWKSet> } | undefined;

/** Verify even on optional-auth/public routes; decoding a payload is never authentication. */
export async function getVerifiedClaims(event: APIGatewayProxyEvent): Promise<JWTPayload | null> {
  const authorization = Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
  if (!authorization?.startsWith('Bearer ')) return null;
  const poolId = process.env.USER_POOL_ID;
  const clientId = process.env.USER_POOL_CLIENT_ID;
  if (!poolId || !clientId || !/^[\w-]+_[\w]+$/.test(poolId)) return null;
  const issuer = `https://cognito-idp.${poolId.split('_')[0]}.amazonaws.com/${poolId}`;
  try {
    if (verifier?.issuer !== issuer) {
      verifier = { issuer, keys: createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
        timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000
      }) };
    }
    const { payload } = await jwtVerify(authorization.slice(7).trim(), verifier.keys, {
      algorithms: ['RS256'], issuer, requiredClaims: ['sub', 'exp', 'iat', 'token_use']
    });
    if (payload.token_use === 'id' && payload.aud === clientId) return payload;
    if (payload.token_use === 'access' && payload.client_id === clientId) return payload;
    return null;
  } catch {
    return null;
  }
}
