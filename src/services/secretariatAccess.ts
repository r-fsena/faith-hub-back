import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { apiResponse } from '../db';
import { requireAuth, enforcePermission, enforceRole, enforceTenant, AuthUser } from './authMiddleware';
import { evaluateTenantFlags } from './featureFlagService';

const SECRETARIAT_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'TREASURER', 'LEADER', 'VOLUNTEER'];

export interface SecretariatScope {
  user: AuthUser;
  organizationId: string;
  campusId: string | null;
}

function requestedOrganization(event: APIGatewayProxyEvent, body: any = {}): string | undefined {
  return event.queryStringParameters?.organization_id || event.headers?.['x-organization-id'] || body.organization_id;
}

function requestedCampus(event: APIGatewayProxyEvent, body: any = {}): string | null {
  const value = event.queryStringParameters?.campus_id || event.headers?.['x-campus-id'] || body.campus_id;
  return value && value !== 'all' ? value : null;
}

export async function authorizeSecretariat(
  event: APIGatewayProxyEvent,
  permission: string,
  body: any = {},
  requiredFeature?: string
): Promise<SecretariatScope | APIGatewayProxyResult> {
  const auth = await requireAuth(event);
  if ('errorResponse' in auth) return auth.errorResponse;

  const roleCheck = enforceRole(auth.user, SECRETARIAT_ROLES);
  if (!roleCheck.allowed) return roleCheck.errorResponse!;

  const permissionCheck = enforcePermission(auth.user, permission);
  if (!permissionCheck.allowed) return permissionCheck.errorResponse!;

  const tenantCheck = enforceTenant(auth.user, requestedOrganization(event, body));
  if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

  const campusId = requestedCampus(event, body);
  const flags = await evaluateTenantFlags(tenantCheck.effectiveOrgId, campusId, 'production');
  if (!flags.flags['secretariat.module_enabled']) {
    return apiResponse(403, {
      error: 'FEATURE_DISABLED',
      message: 'O módulo de Secretaria não está habilitado para esta organização.'
    });
  }
  if (requiredFeature && !flags.flags[requiredFeature]) {
    return apiResponse(403, {
      error: 'FEATURE_DISABLED',
      message: 'Esta funcionalidade da Secretaria não está habilitada para esta organização.'
    });
  }

  return { user: auth.user, organizationId: tenantCheck.effectiveOrgId, campusId };
}

export function isSecretariatResponse(
  value: SecretariatScope | APIGatewayProxyResult
): value is APIGatewayProxyResult {
  return 'statusCode' in value;
}

export function safeSecretariatText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function safeSecretariatDate(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || Number.isNaN(Date.parse(`${normalized}T00:00:00Z`))) {
    throw new Error('INVALID_DATE');
  }
  return normalized;
}

export function secretariatCampusSql(alias: string, campusId: string | null): { clause: string; params: string[] } {
  if (!campusId) return { clause: '', params: [] };
  return {
    clause: ` AND (${alias}.campus_id = ? OR JSON_CONTAINS(${alias}.campus_ids, JSON_QUOTE(?)) OR JSON_CONTAINS(${alias}.campus_ids, '\"all\"'))`,
    params: [campusId, campusId]
  };
}

export function phase2CampusSql(alias: string, campusId: string | null): { clause: string; params: string[] } {
  if (!campusId) return { clause: '', params: [] };
  return { clause: ` AND ${alias}.campus_id = ?`, params: [campusId] };
}
