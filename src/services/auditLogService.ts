import { APIGatewayProxyEvent } from 'aws-lambda';
import { query } from '../db';
import { v4 as uuidv4 } from 'uuid';
import { AuthUser } from './authMiddleware';

export interface AuditLogEntry {
  organizationId: string;
  campusId?: string | null;
  user?: AuthUser | null;
  action: string;
  resource: string;
  resourceId?: string | null;
  details?: any;
  status?: 'SUCCESS' | 'DENIED' | 'ERROR';
  event?: APIGatewayProxyEvent;
}

export async function logSecurityEvent(entry: AuditLogEntry): Promise<void> {
  try {
    const id = uuidv4();
    const user = entry.user;
    const event = entry.event;

    const ipAddress =
      event?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
      event?.requestContext?.identity?.sourceIp ||
      (event?.requestContext as any)?.http?.sourceIp ||
      null;

    const userAgent =
      event?.headers?.['user-agent'] ||
      event?.headers?.['User-Agent'] ||
      null;

    const detailsJson = entry.details ? JSON.stringify(entry.details) : null;

    const sql = `
      INSERT INTO security_audit_logs (
        id, organization_id, campus_id, user_id, user_email, user_role,
        action, resource, resource_id, details, ip_address, user_agent, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await query(sql, [
      id,
      entry.organizationId || user?.organizationId || 'org_default',
      entry.campusId || null,
      user?.userId || null,
      user?.email || null,
      user?.role || 'ANONYMOUS',
      entry.action,
      entry.resource,
      entry.resourceId || null,
      detailsJson,
      ipAddress,
      userAgent,
      entry.status || 'SUCCESS'
    ]);
  } catch (err) {
    // Audit logging should never crash the main transaction
    console.error('Falha ao registrar log de auditoria:', err);
  }
}
