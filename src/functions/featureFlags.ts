import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { apiResponse, query } from '../db';
import {
  evaluateTenantFlags,
  setFeatureFlagOverride,
  EnvironmentScope
} from '../services/featureFlagService';

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
    const orgId =
      event.queryStringParameters?.organization_id ||
      event.headers?.['x-organization-id'] ||
      'org_default';

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
    const body = JSON.parse(event.body || '{}');
    const {
      organization_id,
      campus_id,
      environment = 'all',
      feature_key,
      is_enabled,
      config_payload,
      category,
      description,
      updated_by
    } = body;

    if (!organization_id || !feature_key || is_enabled === undefined) {
      return apiResponse(400, {
        error: 'Campos obrigatórios: organization_id, feature_key e is_enabled'
      });
    }

    await setFeatureFlagOverride({
      organizationId: organization_id,
      campusId: campus_id || null,
      environment: environment as EnvironmentScope,
      featureKey: feature_key,
      isEnabled: Boolean(is_enabled),
      configPayload: config_payload,
      category,
      description,
      updatedBy: updated_by || 'Admin'
    });

    // Retorna as flags atualizadas para atualizar imediatamente o front
    const updated = await evaluateTenantFlags(organization_id, campus_id, environment);

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
    const body = JSON.parse(event.body || '{}');
    const { organization_id, campus_id, environment = 'all', flags, updated_by } = body;

    if (!organization_id || !flags || !Array.isArray(flags)) {
      return apiResponse(400, {
        error: 'Campos obrigatórios: organization_id e array de flags'
      });
    }

    for (const item of flags) {
      if (item.feature_key !== undefined && item.is_enabled !== undefined) {
        await setFeatureFlagOverride({
          organizationId: organization_id,
          campusId: campus_id || null,
          environment: environment as EnvironmentScope,
          featureKey: item.feature_key,
          isEnabled: Boolean(item.is_enabled),
          configPayload: item.config_payload,
          category: item.category,
          description: item.description,
          updatedBy: updated_by || 'Admin'
        });
      }
    }

    const updated = await evaluateTenantFlags(organization_id, campus_id, environment);

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
    const orgId = event.pathParameters?.id;
    if (!orgId || orgId === 'global') {
      return apiResponse(400, { error: 'ID de organização válido é necessário' });
    }

    await query(`DELETE FROM tenant_feature_flags WHERE organization_id = ?`, [orgId]);

    const updated = await evaluateTenantFlags(orgId);

    return apiResponse(200, {
      message: `Overrides de Feature Flags da organização '${orgId}' foram resetados para os padrões.`,
      result: updated
    });
  } catch (error: any) {
    console.error('Error resetting tenant feature flags:', error);
    return apiResponse(500, { error: error.message });
  }
};
