import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';
import { AuthUser, requireAuth, enforceRole, enforceTenant } from './authMiddleware';

const TABLES = new Set(['church_special_projects', 'ministries', 'service_schedules', 'board_posts', 'cell_partilhas', 'cell_groups', 'studies', 'study_books', 'study_chapters', 'devotionals', 'events', 'pdv_products', 'broadcasts', 'kids_rooms', 'members']);
export async function authorizeResource(event: APIGatewayProxyEvent, table: string, id: string, roles?: string[]): Promise<
  { user: AuthUser; organizationId: string; record: any } | { errorResponse: APIGatewayProxyResult }
> {
  const auth = await requireAuth(event);
  if ('errorResponse' in auth) return auth;
  const roleCheck = enforceRole(auth.user, roles || ['SUPERADMIN', 'PASTOR', 'ADMIN', 'TREASURER', 'LEADER', 'VOLUNTEER', 'MEMBER']);
  if (!roleCheck.allowed) return { errorResponse: roleCheck.errorResponse! };
  const tenant = enforceTenant(auth.user, event.headers?.['x-organization-id'] || event.queryStringParameters?.organization_id);
  if (!tenant.allowed) return { errorResponse: tenant.errorResponse! };
  if (!TABLES.has(table)) throw new Error('Unsupported tenant resource');
  const sql = ['board_posts', 'cell_partilhas'].includes(table)
    ? `SELECT p.*, cg.organization_id, cg.campus_id, cg.leader_id FROM ${table} p JOIN cell_groups cg ON cg.id = p.cell_group_id WHERE p.id = ? AND cg.organization_id = ? LIMIT 1`
    : table === 'study_chapters'
    ? 'SELECT c.*, b.organization_id, b.campus_id FROM study_chapters c JOIN study_books b ON b.id = c.book_id WHERE c.id = ? AND b.organization_id = ? LIMIT 1'
    : `SELECT * FROM ${table} WHERE id = ? AND organization_id = ? LIMIT 1`;
  const { rows } = await query(sql, [id, tenant.effectiveOrgId]);
  if (!rows.length) return { errorResponse: apiResponse(404, { message: 'Recurso não encontrado nesta organização' }) };
  if (!auth.user.isSuperAdmin && rows[0].campus_id && !auth.user.campusIds.includes(rows[0].campus_id)) {
    return { errorResponse: apiResponse(403, { message: 'Acesso negado a esta unidade' }) };
  }
  return { user: auth.user, organizationId: tenant.effectiveOrgId, record: rows[0] };
}
