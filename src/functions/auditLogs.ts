import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant } from '../services/authMiddleware';

const AUDIT_ALLOWED_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN'];

// GET /security/audit-logs
export const listAuditLogs = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, AUDIT_ALLOWED_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const requestedOrgId = event.queryStringParameters?.organization_id;
    const tenantCheck = enforceTenant(auth.user, requestedOrgId);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    const orgId = tenantCheck.effectiveOrgId;
    const action = event.queryStringParameters?.action;
    const userEmail = event.queryStringParameters?.user_email;
    const status = event.queryStringParameters?.status;
    const startDate = event.queryStringParameters?.start_date;
    const endDate = event.queryStringParameters?.end_date;
    const limit = Math.min(parseInt(event.queryStringParameters?.limit || '100'), 500);

    let sql = `
      SELECT id, organization_id, campus_id, user_id, user_email, user_role,
             action, resource, resource_id, details, ip_address, user_agent, status, created_at
      FROM security_audit_logs
      WHERE organization_id = ?
    `;
    const params: any[] = [orgId];

    if (action && action !== 'ALL') {
      sql += ` AND action = ?`;
      params.push(action);
    }

    if (userEmail) {
      sql += ` AND user_email LIKE ?`;
      params.push(`%${userEmail}%`);
    }

    if (status && status !== 'ALL') {
      sql += ` AND status = ?`;
      params.push(status);
    }

    if (startDate) {
      sql += ` AND created_at >= ?`;
      params.push(startDate);
    }

    if (endDate) {
      sql += ` AND created_at <= ?`;
      params.push(endDate);
    }

    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const { rows } = await query(sql, params);

    const formatted = rows.map((r: any) => ({
      ...r,
      details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details
    }));

    return apiResponse(200, {
      total: formatted.length,
      data: formatted
    });
  } catch (error: any) {
    console.error('Erro ao consultar logs de auditoria:', error);
    return apiResponse(500, { message: 'Erro ao consultar logs de auditoria' });
  }
};
