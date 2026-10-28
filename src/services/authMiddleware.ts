import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';
import { getVerifiedClaims } from './tokenVerifier';

export interface AuthUser {
  userId: string;
  email: string;
  name: string;
  role: string;
  organizationId: string;
  campusIds: string[];
  operationalPermissions: string[];
  isSuperAdmin: boolean;
}

export function normalizeRole(role: string): string {
  const normalized = String(role).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
  const aliases: Record<string, string> = { 'LIDER DE CELULA': 'LEADER', MEMBRO: 'MEMBER', VISITANTE: 'MEMBER', LIDER: 'LEADER', PASTOR: 'PASTOR', ADMINISTRADOR: 'ADMIN', TESOUREIRO: 'TREASURER', VOLUNTARIO: 'VOLUNTEER', SUPER_ADMIN: 'SUPERADMIN', MASTER_ADMIN: 'SUPERADMIN', MASTER: 'SUPERADMIN', ADMIN_MASTER: 'SUPERADMIN' };
  return aliases[normalized] || normalized;
}

export async function getAuthenticatedUser(event: APIGatewayProxyEvent): Promise<AuthUser | null> {
  try {
    const claims = await getVerifiedClaims(event);
    if (!claims?.sub) return null;
    const email = (claims.email_verified === true || claims.email_verified === 'true') && typeof claims.email === 'string'
      ? claims.email.toLowerCase().trim() : '';
    // Identity bootstrap is the sole cross-tenant member lookup: only verified Cognito identity is used.
    // Do not filter inactive rows here, otherwise an inactive duplicate could resolve to another account.
    const { rows } = await query(
      `SELECT id, name, email, role, status, organization_id, campus_id, campus_ids, operational_permissions FROM members
       WHERE id = ? OR (? != '' AND LOWER(email) = ?) LIMIT 2`,
      [claims.sub, email, email]
    );
    if (rows.length !== 1) return null;
    const member = rows[0];
    if (!member.organization_id || ['INACTIVE', 'INATIVO', 'DISABLED', 'BLOCKED'].includes(String(member.status).toUpperCase())) return null;
    const role = normalizeRole(member.role || 'MEMBER');
    let campusIds: string[] = [];
    try { campusIds = typeof member.campus_ids === 'string' ? JSON.parse(member.campus_ids) : member.campus_ids; } catch {}
    if (!Array.isArray(campusIds) || !campusIds.length) campusIds = [member.campus_id || 'campus_sede'];
    let operationalPermissions: string[] = [];
    try {
      operationalPermissions = typeof member.operational_permissions === 'string'
        ? JSON.parse(member.operational_permissions)
        : member.operational_permissions;
    } catch {}
    if (!Array.isArray(operationalPermissions)) operationalPermissions = [];
    operationalPermissions = operationalPermissions.filter(permission => typeof permission === 'string');
    return {
      userId: member.id, email: member.email || email, name: member.name || 'Usuário', role,
      organizationId: member.organization_id, campusIds, operationalPermissions, isSuperAdmin: role === 'SUPERADMIN'
    };
  } catch (error) {
    console.error('Error resolving authenticated user:', error);
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
  let body: any = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const requestedCampus = event.headers?.['x-campus-id'] || event.queryStringParameters?.campus_id || body.campus_id;
  if (!user.isSuperAdmin && requestedCampus && requestedCampus !== 'all' && !user.campusIds.includes(requestedCampus)) {
    return { errorResponse: apiResponse(403, { error: 'CROSS_CAMPUS_FORBIDDEN', message: 'Acesso negado a esta unidade' }) };
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

  const normalizedAllowed = allowedRoles.map(normalizeRole);
  if (!normalizedAllowed.includes(normalizeRole(user.role))) {
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
 * Enforces a functional permission without expanding the canonical role hierarchy.
 * SUPERADMIN, PASTOR and ADMIN remain privileged; delegated operators must receive
 * an explicit permission through members.operational_permissions.
 */
export function enforcePermission(
  user: AuthUser,
  requiredPermission: string,
  privilegedRoles: string[] = ['SUPERADMIN', 'PASTOR', 'ADMIN']
): { allowed: boolean; errorResponse?: APIGatewayProxyResult } {
  if (user.isSuperAdmin || privilegedRoles.map(normalizeRole).includes(normalizeRole(user.role))) {
    return { allowed: true };
  }

  const permissions = Array.isArray(user.operationalPermissions) ? user.operationalPermissions : [];
  const domain = requiredPermission.split('.')[0];
  const allowed = permissions.includes(requiredPermission) || permissions.includes(`${domain}.*`);
  if (!allowed) {
    console.warn(`[SECURITY ALERT] Permissão funcional negada! Usuário ${user.email} tentou acessar '${requiredPermission}'`);
    return {
      allowed: false,
      errorResponse: apiResponse(403, {
        error: 'FUNCTIONAL_PERMISSION_REQUIRED',
        message: 'Acesso negado: esta função exige uma permissão operacional específica.'
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
