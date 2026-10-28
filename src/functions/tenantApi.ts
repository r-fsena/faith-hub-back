import * as churchSettings from './churchSettings';
import * as pagarmeSettings from './pagarmeSettings';
import * as organizations from './organizations';
import * as campuses from './campuses';
import * as featureFlags from './featureFlags';
import * as auditLogs from './auditLogs';
import { createDomainApiHandler, DomainRouteMap } from './domainApiRouter';

export const tenantApiRoutes: DomainRouteMap = {
  'GET /CHURCH-SETTINGS': churchSettings.getSettings,
  'POST /CHURCH-SETTINGS': churchSettings.updateSettings,
  'GET /PAGARME-SETTINGS': pagarmeSettings.getGatewayConfig,
  'POST /PAGARME-SETTINGS': pagarmeSettings.updateGatewayConfig,
  'GET /ORGANIZATIONS': organizations.listOrganizations,
  'GET /ORGANIZATIONS/{ID}': organizations.getOrganization,
  'POST /ORGANIZATIONS': organizations.createOrUpdateOrganization,
  'GET /CAMPUSES': campuses.listCampuses,
  'GET /CAMPUSES/{ID}': campuses.getCampus,
  'POST /CAMPUSES': campuses.createOrUpdateCampus,
  'DELETE /CAMPUSES/{ID}': campuses.deleteCampus,
  'GET /FEATURE-FLAGS': featureFlags.getFeatureFlags,
  'POST /FEATURE-FLAGS/TOGGLE': featureFlags.toggleFeatureFlag,
  'POST /FEATURE-FLAGS/BATCH': featureFlags.batchUpdateFeatureFlags,
  'DELETE /FEATURE-FLAGS/TENANT/{ID}': featureFlags.resetTenantFlags,
  'GET /SECURITY/AUDIT-LOGS': auditLogs.listAuditLogs
};

export const tenantApiHandler = createDomainApiHandler(tenantApiRoutes);
