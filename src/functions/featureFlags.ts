import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { apiResponse, query } from '../db';
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';
import {
  evaluateTenantFlags,
  setFeatureFlagOverride,
  EnvironmentScope
} from '../services/featureFlagService';

const FF_ADMIN_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN'];

/**
 * GET /feature-flags
 * Query parameters:
 *  - organization_id: string (default: 'org_default')
 *  - campus_id: string (optional)
 *  - environment: 'all' | 'development' | 'staging' | 'production' (default: 'production')
 */
export const getFeatureFlags = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const requestedOrgId =
      event.queryStringParameters?.organization_id ||
      event.headers?.['x-organization-id'] ||
      'org_default';

    const orgId = user ? enforceTenant(user, requestedOrgId).effectiveOrgId : requestedOrgId;

    const campusId =
      event.queryStringParameters?.campus_id ||
      event.headers?.['x-campus-id'] ||
      null;

    const env =
      (event.queryStringParameters?.environment as EnvironmentScope) ||
      (event.queryStringParameters?.env as EnvironmentScope) ||
      (event.headers?.['x-environment'] as EnvironmentScope) ||
      'production';

    const result = await evaluateTenantFlags(orgId, campusId, env);
    return apiResponse(200, result);
  } catch (error: any) {
    console.error('Error fetching feature flags:', error);
    return apiResponse(500, { error: error.message });
  }
};

/**
 * POST /feature-flags/toggle
 * Body:
 *  - organization_id: string
 *  - campus_id?: string | null
 *  - environment?: EnvironmentScope
 *  - feature_key: string
 *  - is_enabled: boolean
 *  - config_payload?: any
 *  - category?: string
 *  - description?: string
 */
export const toggleFeatureFlag = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, FF_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const {
      organization_id,
      campus_id,
      environment = 'all',
      feature_key,
      is_enabled,
      config_payload,
      category,
      description
    } = body;

    const tenantCheck = enforceTenant(auth.user, organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgId = tenantCheck.effectiveOrgId;

    if (!feature_key || is_enabled === undefined) {
      return apiResponse(400, {
        error: 'Campos obrigatórios: feature_key e is_enabled'
      });
    }

    await setFeatureFlagOverride({
      organizationId: orgId,
      campusId: campus_id || null,
      environment: environment as EnvironmentScope,
      featureKey: feature_key,
      isEnabled: Boolean(is_enabled),
      configPayload: config_payload,
      category,
      description,
      updatedBy: auth.user.name || auth.user.email || 'Admin'
    });

    await logSecurityEvent({
      organizationId: orgId,
      user: auth.user,
      action: 'TOGGLE_FEATURE_FLAG',
      resource: 'tenant_feature_flags',
      resourceId: feature_key,
      details: { is_enabled: Boolean(is_enabled), environment },
      event
    });

    const updated = await evaluateTenantFlags(orgId, campus_id, environment as EnvironmentScope);

    return apiResponse(200, {
      message: `Feature flag '${feature_key}' atualizada com sucesso para a organização.`,
      result: updated
    });
  } catch (error: any) {
    console.error('Error toggling feature flag:', error);
    return apiResponse(500, { error: error.message });
  }
};

/**
 * POST /feature-flags/batch
 * Atualiza múltiplas flags de uma só vez (ex: aplicar preset de plano ou reconfigurar tenant)
 */
export const batchUpdateFeatureFlags = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, FF_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const { organization_id, campus_id, environment = 'all', flags } = body;

    const tenantCheck = enforceTenant(auth.user, organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgId = tenantCheck.effectiveOrgId;

    if (!flags || !Array.isArray(flags)) {
      return apiResponse(400, {
        error: 'Campo obrigatório: array de flags'
      });
    }

    for (const item of flags) {
      if (item.feature_key !== undefined && item.is_enabled !== undefined) {
        await setFeatureFlagOverride({
          organizationId: orgId,
          campusId: campus_id || null,
          environment: environment as EnvironmentScope,
          featureKey: item.feature_key,
          isEnabled: Boolean(item.is_enabled),
          configPayload: item.config_payload,
          category: item.category,
          description: item.description,
          updatedBy: auth.user.name || auth.user.email || 'Admin'
        });
      }
    }

    await logSecurityEvent({
      organizationId: orgId,
      user: auth.user,
      action: 'BATCH_UPDATE_FEATURE_FLAGS',
      resource: 'tenant_feature_flags',
      details: { total_flags: flags.length, environment },
      event
    });

    const updated = await evaluateTenantFlags(orgId, campus_id, environment as EnvironmentScope);

    return apiResponse(200, {
      message: `${flags.length} Feature flags atualizadas em lote com sucesso!`,
      result: updated
    });
  } catch (error: any) {
    console.error('Error batch updating feature flags:', error);
    return apiResponse(500, { error: error.message });
  }
};

/**
 * DELETE /feature-flags/tenant/{id}
 * Remove todos os overrides específicos do tenant, restaurando para o padrão global/plano
 */
export const resetTenantFlags = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, FF_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const orgId = event.pathParameters?.id;
    if (!orgId || orgId === 'global') {
      return apiResponse(400, { error: 'ID de organização válido é necessário' });
    }

    const tenantCheck = enforceTenant(auth.user, orgId);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    await query(`DELETE FROM tenant_feature_flags WHERE organization_id = ?`, [tenantCheck.effectiveOrgId]);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'RESET_TENANT_FEATURE_FLAGS',
      resource: 'tenant_feature_flags',
      resourceId: tenantCheck.effectiveOrgId,
      event
    });

    const updated = await evaluateTenantFlags(tenantCheck.effectiveOrgId);

    return apiResponse(200, {
      message: `Overrides de Feature Flags da organização '${tenantCheck.effectiveOrgId}' foram resetados para os padrões.`,
      result: updated
    });
  } catch (error: any) {
    console.error('Error resetting tenant feature flags:', error);
    return apiResponse(500, { error: error.message });
  }
};

