import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { apiResponse } from '../db';
import { enforceTenant, getAuthenticatedUser } from './authMiddleware';
import { evaluateTenantFlags } from './featureFlagService';

/** Used by individual handlers as well as consolidated Lambdas; hiding a menu is insufficient. */
export async function enforcePlanAccess(event: APIGatewayProxyEvent, feature: string): Promise<APIGatewayProxyResult | null> {
  try {
    const body = JSON.parse(event.body || '{}');
    const user = await getAuthenticatedUser(event);
    const organizations = [event.headers?.['x-organization-id'], event.headers?.['X-Organization-Id'],
      event.queryStringParameters?.organization_id, body.organization_id].filter(Boolean);
    const campuses = [event.headers?.['x-campus-id'], event.queryStringParameters?.campus_id, body.campus_id].filter(Boolean);
    if (user) {
      for (const organization of organizations) {
        const scope = enforceTenant(user, organization);
        if (!scope.allowed) return scope.errorResponse!;
      }
    }
    if (new Set(organizations).size > 1 || new Set(campuses).size > 1) {
      return apiResponse(400, { error: 'CONFLICTING_TENANT_SCOPE' });
    }
    const tenant = user ? enforceTenant(user, organizations[0]) : null;
    if (tenant && !tenant.allowed) return tenant.errorResponse!;
    const orgId = tenant?.effectiveOrgId || organizations[0] || 'org_default';
    const campusId = campuses[0] && campuses[0] !== 'all' ? campuses[0] : null;
    if (user && !user.isSuperAdmin && campusId && !user.campusIds.includes(campusId)) {
      return apiResponse(403, { error: 'CROSS_CAMPUS_FORBIDDEN' });
    }
    const evaluated = await evaluateTenantFlags(orgId, campusId, 'production');
    // Existing agreements keep their former behavior until an explicit, reviewed plan change.
    if (!evaluated.contract_version) return null;
    if (!evaluated.flags[feature]) {
      return apiResponse(403, { error: 'PLAN_FEATURE_NOT_INCLUDED', feature,
        message: 'Este recurso não está contratado ou está desativado para esta igreja.' });
    }
    return null;
  } catch (error) {
    if (error instanceof SyntaxError) return apiResponse(400, { error: 'INVALID_JSON' });
    console.error('Falha ao validar recurso contratado', error);
    return apiResponse(503, { error: 'PLAN_ACCESS_UNAVAILABLE', message: 'Não foi possível validar os recursos contratados.' });
  }
}
