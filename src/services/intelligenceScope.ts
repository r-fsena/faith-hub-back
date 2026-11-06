import { apiResponse, query } from '../db';
import { AuthUser, enforceTenant } from './authMiddleware';
import { safeIdentifier } from './intelligenceModel';

export interface IntelligenceScope {
  user: AuthUser; organizationId: string; campusId: string | null;
  campusIds: string[] | null; cellIds: string[] | null;
}
export async function intelligenceScope(event: any, user: AuthUser, body: any = {}): Promise<IntelligenceScope | any> {
  const orgs = [event.queryStringParameters?.organization_id, event.headers?.['x-organization-id'], body.organization_id].filter(Boolean);
  if (orgs.some(id => !safeIdentifier(id)) || new Set(orgs).size > 1) return apiResponse(403, { message: 'Organização inválida ou conflitante.' });
  const tenant = enforceTenant(user, orgs[0]);
  if (!tenant.allowed) return tenant.errorResponse!;
  const campusValues = [event.queryStringParameters?.campus_id, event.headers?.['x-campus-id'], body.campus_id].filter(Boolean);
  if (new Set(campusValues).size > 1 || campusValues.some(id => id !== 'all' && !safeIdentifier(id))) return apiResponse(403, { message: 'Unidade inválida ou conflitante.' });
  const campusId = campusValues[0] && campusValues[0] !== 'all' ? campusValues[0] : null;
  if (campusId) {
    if (!user.isSuperAdmin && !user.campusIds.includes('all') && !user.campusIds.includes(campusId)) return apiResponse(403, { message: 'Sem acesso a esta unidade.' });
    const {rows} = await query('SELECT id FROM campuses WHERE organization_id = ? AND id = ?', [tenant.effectiveOrgId, campusId]);
    if (!rows.length) return apiResponse(404, {message:'Unidade não encontrada.'});
  }
  const campusIds = campusId ? [campusId] : user.isSuperAdmin || user.campusIds.includes('all') ? null : user.campusIds;
  const scope: IntelligenceScope = { user, organizationId: tenant.effectiveOrgId, campusId, campusIds, cellIds: null };
  if (user.role === 'LEADER') {
    const filter = scopedWhere(scope, 'cg');
    const {rows} = await query(`SELECT cg.id FROM cell_groups cg WHERE cg.organization_id = ? AND cg.leader_id = ?${filter.sql}`, [scope.organizationId, user.userId, ...filter.params]);
    scope.cellIds = rows.map(row => row.id);
  }
  return scope;
}
export function scopedWhere(scope: IntelligenceScope, alias: string, campusColumn = 'campus_id', cellColumn?: string) {
  const params: string[] = [];
  let sql = '';
  if (scope.campusIds) {
    sql += scope.campusIds.length ? ` AND COALESCE(${alias}.${campusColumn}, 'campus_sede') IN (${scope.campusIds.map(() => '?').join(',')})` : ' AND 1 = 0';
    params.push(...scope.campusIds);
  }
  if (scope.cellIds) {
    sql += scope.cellIds.length && cellColumn ? ` AND ${alias}.${cellColumn} IN (${scope.cellIds.map(() => '?').join(',')})` : ' AND 1 = 0';
    if (scope.cellIds.length && cellColumn) params.push(...scope.cellIds);
  }
  return {sql, params};
}
