import { APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';
import { getVerifiedClaims } from './tokenVerifier';
import { AuthUser, requireAuth, enforceRole, enforceTenant } from './authMiddleware';

export const MINISTRY_VIEW_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'TREASURER', 'LEADER', 'VOLUNTEER', 'MEMBER'];
export class MinistryScopeError extends Error {
  constructor(public response: APIGatewayProxyResult) { super('MINISTRY_SCOPE_DENIED'); }
}
export interface MinistryScope {
  user: AuthUser; organizationId: string; campusId: string | null; identityId: string; identityEmail: string;
  memberPromise?: Promise<any | null>;
}
const contexts = new WeakMap<object, Promise<MinistryScope | { errorResponse: APIGatewayProxyResult }>>();
export function requireMinistryAuth(event: any): Promise<MinistryScope | { errorResponse: APIGatewayProxyResult }> {
  const cached = contexts.get(event); if (cached) return cached;
  const promise = resolve(event); contexts.set(event, promise); return promise;
}
async function resolve(event: any): Promise<MinistryScope | { errorResponse: APIGatewayProxyResult }> {
  const auth = await requireAuth(event); if ('errorResponse' in auth) return auth;
  const claims = await getVerifiedClaims(event);
  if (!claims?.sub) return { errorResponse: apiResponse(401, { error: 'UNAUTHORIZED' }) };
  const identityEmail = (claims.email_verified === true || claims.email_verified === 'true') && typeof claims.email === 'string' ? claims.email.toLowerCase().trim() : '';
  const role = enforceRole(auth.user, MINISTRY_VIEW_ROLES); if (!role.allowed) return { errorResponse: role.errorResponse! };
  let body: any; try { body = JSON.parse(event.body || '{}'); } catch { return { errorResponse: apiResponse(400, { error: 'INVALID_JSON' }) }; }
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const q = event.queryStringParameters || {};
  const organizations = [headers['x-organization-id'], q.organization_id, body.organization_id].filter(Boolean) as string[];
  const campuses = [headers['x-campus-id'], q.campus_id, body.campus_id].filter(Boolean) as string[];
  for (const org of organizations) { const t = enforceTenant(auth.user, org); if (!t.allowed) return { errorResponse: t.errorResponse! }; }
  if (new Set(organizations).size > 1 || new Set(campuses).size > 1) return { errorResponse: apiResponse(400, { error: 'CONFLICTING_TENANT_SCOPE' }) };
  const tenant = enforceTenant(auth.user, organizations[0]); if (!tenant.allowed) return { errorResponse: tenant.errorResponse! };
  const campusId = campuses[0] && campuses[0] !== 'all' ? campuses[0] : null;
  if (campusId) {
    if (!auth.user.isSuperAdmin && !auth.user.campusIds.includes('all') && !auth.user.campusIds.includes(campusId)) return { errorResponse: apiResponse(403, { error: 'CROSS_CAMPUS_FORBIDDEN' }) };
    const { rows } = await query('SELECT id FROM campuses WHERE organization_id = ? AND id = ? LIMIT 1', [tenant.effectiveOrgId, campusId]);
    if (!rows.length) return { errorResponse: apiResponse(404, { error: 'CAMPUS_NOT_FOUND_IN_ORGANIZATION' }) };
  }
  return { user: auth.user, organizationId: tenant.effectiveOrgId, campusId, identityId: claims.sub, identityEmail };
}
export function campusFilter(scope: MinistryScope, alias: string): { sql: string; params: string[] } {
  if (!/^[a-z_]+$/i.test(alias)) throw Error('INVALID_SQL_ALIAS');
  if (scope.campusId) return { sql: ` AND (${alias}.campus_id = ? OR ${alias}.campus_id IS NULL)`, params: [scope.campusId] };
  if (scope.user.isSuperAdmin || scope.user.campusIds.includes('all')) return { sql: '', params: [] };
  const campuses = scope.user.campusIds.filter(c => c && c !== 'all');
  return campuses.length ? { sql: ` AND (${alias}.campus_id IN (${campuses.map(() => '?').join(',')}) OR ${alias}.campus_id IS NULL)`, params: campuses } : { sql: ` AND ${alias}.campus_id IS NULL`, params: [] };
}
export function assertCampus(scope: MinistryScope, campus: string | null | undefined) {
  if (campus && ((scope.campusId && scope.campusId !== campus) || (!scope.user.isSuperAdmin && !scope.user.campusIds.includes('all') && !scope.user.campusIds.includes(campus)))) {
    throw new MinistryScopeError(apiResponse(403, { error: 'CROSS_CAMPUS_FORBIDDEN', message: 'Este ministério ou escala pertence a outra unidade.' }));
  }
}
export async function scopedMinistry(scope: MinistryScope, id: string) {
  const { rows } = await query('SELECT * FROM ministries WHERE id = ? AND organization_id = ? LIMIT 1', [id, scope.organizationId]);
  if (!rows.length) throw new MinistryScopeError(apiResponse(404, { error: 'MINISTRY_NOT_FOUND_IN_ORGANIZATION' }));
  assertCampus(scope, rows[0].campus_id); return rows[0];
}
export function volunteerMember(scope: MinistryScope): Promise<any | null> {
  if (!scope.memberPromise) scope.memberPromise = (async () => {
    const email = scope.identityEmail;
    const { rows } = await query(`SELECT id, email, status FROM members
      WHERE organization_id = ? AND (id = ? OR id = ? OR (? <> '' AND LOWER(email) = ?)) LIMIT 2`, [scope.organizationId, scope.user.userId, scope.identityId, email, email]);
    const own = rows.find(m => m.id === scope.user.userId) || (rows.length === 1 ? rows[0] : null);
    if (!own || ['INACTIVE', 'INATIVO', 'DISABLED', 'BLOCKED'].includes(String(own.status).toUpperCase())) return null;
    return own;
  })();
  return scope.memberPromise;
}
export async function requireVolunteerMember(scope: MinistryScope) {
  const member = await volunteerMember(scope);
  if (!member) throw new MinistryScopeError(apiResponse(403, { error: 'MEMBER_NOT_LINKED_TO_ORGANIZATION', message: 'Seu cadastro de membro precisa estar vinculado a esta igreja.' }));
  return member;
}
export async function isMinistryParticipant(scope: MinistryScope, ministry: any, member: any, activeOnly = false) {
  if (!member) return false;
  if (ministry.leader_id && [String(member.id).toLowerCase(), member.email?.toLowerCase()].includes(String(ministry.leader_id).toLowerCase())) return true;
  const { rows } = await query(`SELECT id FROM ministry_volunteers WHERE organization_id = ? AND ministry_id = ? AND member_id = ? AND status IN (${activeOnly ? "'ACTIVE'" : "'ACTIVE','TRAINING'"}) LIMIT 1`, [scope.organizationId, ministry.id, member.id]);
  return rows.length > 0;
}
export function ministryFailure(error: unknown) {
  if (error instanceof MinistryScopeError) return error.response;
  console.error('Falha no fluxo de voluntariado', error instanceof Error ? error.name : 'UnknownError');
  return apiResponse(500, { error: 'VOLUNTEER_REQUEST_FAILED' });
}
