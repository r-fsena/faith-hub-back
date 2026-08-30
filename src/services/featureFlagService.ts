import { APIGatewayProxyEvent } from 'aws-lambda';
import { query } from '../db';
import { v4 as uuidv4 } from 'uuid';

export type EnvironmentScope = 'all' | 'development' | 'staging' | 'production';

export interface FeatureFlagRecord {
  id: string;
  organization_id: string;
  campus_id?: string | null;
  environment: EnvironmentScope;
  feature_key: string;
  is_enabled: boolean | number;
  config_payload?: any;
  category?: string;
  description?: string;
  updated_by?: string;
}

export interface ResolvedFeatureFlags {
  organization_id: string;
  campus_id?: string | null;
  environment: string;
  plan: string;
  flags: Record<string, boolean>;
  configs: Record<string, any>;
  catalog: Array<{
    key: string;
    category: string;
    description: string;
    enabled: boolean;
    hasOverride: boolean;
    config?: any;
  }>;
}

// Plan-based default permissions
const PLAN_CONSTRAINTS: Record<string, { disabledPrefixes?: string[]; disabledKeys?: string[] }> = {
  STARTER: {
    disabledPrefixes: ['pdv.', 'kids.express_kiosk_checkin', 'kids.thermal_badge_printing', 'system.multicampus_enabled', 'system.custom_domain']
  },
  PRO: {
    disabledPrefixes: ['system.custom_domain']
  },
  ENTERPRISE: {}
};

/**
 * Resolves all feature flags for a given tenant, campus, and environment.
 * Applies 5-level inheritance:
 * 1. Global Defaults
 * 2. SaaS Plan constraints
 * 3. Environment matching
 * 4. Tenant overrides (organization_id)
 * 5. Campus overrides (campus_id)
 */
export async function evaluateTenantFlags(
  organizationId: string = 'org_default',
  campusId?: string | null,
  environment: EnvironmentScope = 'production'
): Promise<ResolvedFeatureFlags> {
  // 1. Fetch organization details (e.g. Plan)
  let orgPlan = 'PRO';
  try {
    const { rows: orgRows } = await query(
      `SELECT plan, status FROM organizations WHERE id = ? LIMIT 1`,
      [organizationId]
    );
    if (orgRows.length > 0 && orgRows[0].plan) {
      orgPlan = orgRows[0].plan.toUpperCase();
    }
  } catch (err) {
    console.warn('Could not fetch org plan, defaulting to PRO:', err);
  }

  // 2. Fetch all applicable flags from DB in a single optimized query
  const { rows } = await query(
    `SELECT * FROM tenant_feature_flags
     WHERE (organization_id = 'global' OR organization_id = ?)
       AND (environment = 'all' OR environment = ?)
       AND (campus_id IS NULL OR campus_id = ?)
     ORDER BY 
       CASE 
         WHEN organization_id = 'global' THEN 1
         ELSE 2
       END ASC,
       CASE 
         WHEN campus_id IS NULL THEN 1
         ELSE 2
       END ASC`,
    [organizationId, environment, campusId || '']
  );

  const flagsMap: Record<string, boolean> = {};
  const configsMap: Record<string, any> = {};
  const catalogMap: Map<string, { category: string; description: string; hasOverride: boolean }> = new Map();

  // Process rows with cascading overrides
  for (const r of rows) {
    const key = r.feature_key;
    const isGlobal = r.organization_id === 'global';
    const isEnabled = Boolean(Number(r.is_enabled));

    flagsMap[key] = isEnabled;

    if (r.config_payload) {
      try {
        configsMap[key] = typeof r.config_payload === 'string' ? JSON.parse(r.config_payload) : r.config_payload;
      } catch {
        configsMap[key] = r.config_payload;
      }
    }

    if (!catalogMap.has(key) || !isGlobal) {
      catalogMap.set(key, {
        category: r.category || 'Geral',
        description: r.description || '',
        hasOverride: !isGlobal
      });
    }
  }

  // 3. Apply SaaS Plan constraints (if flag not explicitly overridden by tenant)
  const planRules = PLAN_CONSTRAINTS[orgPlan] || {};
  if (planRules.disabledPrefixes) {
    for (const prefix of planRules.disabledPrefixes) {
      for (const key of Object.keys(flagsMap)) {
        if (key.startsWith(prefix) && !catalogMap.get(key)?.hasOverride) {
          flagsMap[key] = false;
        }
      }
    }
  }
  if (planRules.disabledKeys) {
    for (const key of planRules.disabledKeys) {
      if (!catalogMap.get(key)?.hasOverride) {
        flagsMap[key] = false;
      }
    }
  }

  // Build catalog array for admin UI
  const catalog = Array.from(catalogMap.entries()).map(([key, meta]) => ({
    key,
    category: meta.category,
    description: meta.description,
    enabled: Boolean(flagsMap[key]),
    hasOverride: meta.hasOverride,
    config: configsMap[key] || null
  }));

  return {
    organization_id: organizationId,
    campus_id: campusId || null,
    environment,
    plan: orgPlan,
    flags: flagsMap,
    configs: configsMap,
    catalog
  };
}

/**
 * Checks if a specific feature flag is active for a Lambda event request.
 * Automatically extracts org_id, campus_id, env from headers or query parameters.
 */
export async function requireFeature(
  event: APIGatewayProxyEvent,
  featureKey: string
): Promise<boolean> {
  try {
    const orgId =
      event.headers?.['x-organization-id'] ||
      event.headers?.['X-Organization-Id'] ||
      event.queryStringParameters?.organization_id ||
      'org_default';

    const campusId =
      event.headers?.['x-campus-id'] ||
      event.headers?.['X-Campus-Id'] ||
      event.queryStringParameters?.campus_id ||
      null;

    const env =
      (event.headers?.['x-environment'] as EnvironmentScope) ||
      (event.queryStringParameters?.env as EnvironmentScope) ||
      'production';

    const evaluated = await evaluateTenantFlags(orgId, campusId, env);
    return Boolean(evaluated.flags[featureKey]);
  } catch (error) {
    console.error(`Error evaluating feature flag [${featureKey}]:`, error);
    return true; // Graceful fallback
  }
}

/**
 * Saves or updates a tenant-specific feature flag override.
 */
export async function setFeatureFlagOverride(params: {
  organizationId: string;
  campusId?: string | null;
  environment?: EnvironmentScope;
  featureKey: string;
  isEnabled: boolean;
  configPayload?: any;
  category?: string;
  description?: string;
  updatedBy?: string;
}): Promise<void> {
  const {
    organizationId,
    campusId = null,
    environment = 'all',
    featureKey,
    isEnabled,
    configPayload = null,
    category = 'Geral',
    description = '',
    updatedBy = 'Admin'
  } = params;

  const flagId = `ff_${organizationId}_${campusId || 'all'}_${environment}_${featureKey.replace(/\./g, '_')}`;
  const configJson = configPayload ? JSON.stringify(configPayload) : null;

  const sql = `
    INSERT INTO tenant_feature_flags (
      id, organization_id, campus_id, environment, feature_key, is_enabled, config_payload, category, description, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      is_enabled = VALUES(is_enabled),
      config_payload = VALUES(config_payload),
      category = VALUES(category),
      description = VALUES(description),
      updated_by = VALUES(updated_by),
      updated_at = NOW()
  `;

  await query(sql, [
    flagId,
    organizationId,
    campusId,
    environment,
    featureKey,
    isEnabled ? 1 : 0,
    configJson,
    category,
    description,
    updatedBy
  ]);
}
