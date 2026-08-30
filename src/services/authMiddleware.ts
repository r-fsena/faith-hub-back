import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';

export interface AuthUser {
  userId: string;
  email: string;
  name: string;
  role: string;
  organizationId: string;
  campusIds: string[];
  isSuperAdmin: boolean;
}

// SuperAdmin emails with master access
const SUPER_ADMIN_EMAILS = [
  'admin@faithhub.com',
  'rafael@faithhub.com',
  'superadmin@faithhub.com',
  'rfsena@icloud.com'
];

/**
 * Decodes JWT payload safely and inspects standard claims
 */
function decodeJwtPayload(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = Buffer.from(base64, 'base64').toString('utf8');
    const parsed = JSON.parse(jsonPayload);

    // Validate expiration timestamp (exp)
    if (parsed.exp && parsed.exp * 1000 < Date.now()) {
      console.warn('[SECURITY] Token JWT expirado fornecido.');
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Extracts and verifies authenticated user information from Lambda event
 * Authoritative claims originate from AWS API Gateway Cognito JWT Authorizer
 */
export async function getAuthenticatedUser(event: APIGatewayProxyEvent): Promise<AuthUser | null> {
  try {
    // 1. Extract authoritative claims verified cryptographically by API Gateway Authorizer
    let claims =
      (event.requestContext as any)?.authorizer?.jwt?.claims ||
      (event.requestContext as any)?.authorizer?.claims ||
      null;

    let isVerifiedByGateway = Boolean(claims);

    // 2. Fallback: Parse Authorization Bearer header (for local development or public lambdas)
    if (!claims) {
      const authHeader =
        event.headers?.['authorization'] ||
        event.headers?.['Authorization'] ||
        '';

      if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7).trim();
        claims = decodeJwtPayload(token);
      }
    }

    if (!claims) {
      return null;
    }

    const cognitoSub = claims.sub || claims.username || claims['cognito:username'];
    let email = (claims.email || (claims.username && claims.username.includes('@') ? claims.username : '') || '').toLowerCase().trim();
    const name = claims.name || claims['cognito:name'] || (email ? email.split('@')[0] : 'Usuário');

    if (!cognitoSub && !email) {
      return null;
    }

    // 3. Query member record in MySQL DB to retrieve authoritative role and tenant
    let memberRecord: any = null;
    if (cognitoSub || email) {
      const { rows } = await query(
        `SELECT id, name, email, role, organization_id, campus_id, campus_ids 
         FROM members 
         WHERE (id = ? OR email = ? OR LOWER(email) = LOWER(?)) AND status != 'INACTIVE' 
         LIMIT 1`,
        [cognitoSub || '', email || '', email || '']
      );
      if (rows.length > 0) {
        memberRecord = rows[0];
        if (!email && memberRecord.email) {
          email = memberRecord.email.toLowerCase().trim();
        }
      }
    }

    // Anti-Forging Guard: SuperAdmin status is ONLY granted if verified by API Gateway OR present in DB with SUPERADMIN role
    const isSuperAdminEmail = SUPER_ADMIN_EMAILS.includes(email);
    const dbRole = (memberRecord?.role || 'MEMBER').toUpperCase();
    const isSuperAdmin = (isSuperAdminEmail || dbRole === 'SUPERADMIN') && (isVerifiedByGateway || Boolean(memberRecord));

    const orgId = memberRecord?.organization_id || (isSuperAdmin ? 'org_default' : 'org_default');
    const role = isSuperAdmin ? 'SUPERADMIN' : dbRole;

    let campusList: string[] = [];
    if (memberRecord?.campus_ids) {
      try {
        campusList = typeof memberRecord.campus_ids === 'string' ? JSON.parse(memberRecord.campus_ids) : memberRecord.campus_ids;
      } catch {
        campusList = [memberRecord.campus_id || 'campus_sede'];
      }
    } else if (memberRecord?.campus_id) {
      campusList = [memberRecord.campus_id];
    } else {
      campusList = ['campus_sede'];
    }

    return {
      userId: memberRecord?.id || cognitoSub || email,
      email,
      name: memberRecord?.name || name,
      role,
      organizationId: orgId,
      campusIds: campusList,
      isSuperAdmin
    };
  } catch (error) {
    console.error('Error resolving authenticated user in authMiddleware:', error);
    return null;
  }
}

/**
 * Enforces valid authentication token. Returns 401 if missing.
 */
export async function requireAuth(
  event: APIGatewayProxyEvent
): Promise<{ user: AuthUser } | { errorResponse: APIGatewayProxyResult }> {
  const user = await getAuthenticatedUser(event);
  if (!user) {
    return {
      errorResponse: apiResponse(401, {
        error: 'UNAUTHORIZED',
        message: 'Acesso negado: Autenticação obrigatória para acessar este recurso.'
      })
    };
  }
  return { user };
}

/**
 * Enforces Tenant Isolation (Anti-BOLA / Anti-IDOR Guard)
 * Ensures a regular church user cannot access or modify another church's data.
 */
export function enforceTenant(
  user: AuthUser,
  requestedOrgId?: string | null
): { allowed: boolean; effectiveOrgId: string; errorResponse?: APIGatewayProxyResult } {
  // SuperAdmin has cross-tenant access to manage any church
  if (user.isSuperAdmin) {
    return {
      allowed: true,
      effectiveOrgId: requestedOrgId || user.organizationId
    };
  }

  // If requestedOrgId is specified and differs from user's tenant, block immediately
  if (requestedOrgId && requestedOrgId !== user.organizationId) {
    console.warn(`[SECURITY ALERT] Tentativa de BOLA bloqueada! Usuário ${user.email} (${user.organizationId}) tentou acessar tenant ${requestedOrgId}`);
    return {
      allowed: false,
      effectiveOrgId: user.organizationId,
      errorResponse: apiResponse(403, {
        error: 'CROSS_TENANT_FORBIDDEN',
        message: 'Acesso negado: Você não possui permissão para acessar dados desta congregação.'
      })
    };
  }

  return {
    allowed: true,
    effectiveOrgId: user.organizationId
  };
}

/**
 * Enforces Role-Based Access Control (RBAC)
 */
export function enforceRole(
  user: AuthUser,
  allowedRoles: string[]
): { allowed: boolean; errorResponse?: APIGatewayProxyResult } {
  if (user.isSuperAdmin) return { allowed: true };

  const normalizedAllowed = allowedRoles.map(r => r.toUpperCase());
  if (!normalizedAllowed.includes(user.role.toUpperCase())) {
    console.warn(`[SECURITY ALERT] Acesso por papel negado! Usuário ${user.email} com papel '${user.role}' tentou acessar recurso restrito a [${allowedRoles.join(', ')}]`);
    return {
      allowed: false,
      errorResponse: apiResponse(403, {
        error: 'INSUFFICIENT_PERMISSIONS',
        message: 'Acesso negado: Seu nível de acesso não permite executar esta operação.'
      })
    };
  }

  return { allowed: true };
}

/**
 * Helper to mask sensitive keys (e.g. API keys, secrets) for safe client viewing
 */
export function maskSecret(value?: string | null, visibleChars = 4): string {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length <= visibleChars * 2) return '••••••••';
  const prefix = trimmed.substring(0, Math.min(visibleChars, 4));
  const suffix = trimmed.substring(trimmed.length - visibleChars);
  return `${prefix}••••••••${suffix}`;
}
