/**
 * Keeps the root CloudFormation stack below AWS' 500-resource limit.
 * Existing resources are never force-migrated. New aggregate handlers are
 * created directly inside domain stacks while the existing API routes retain
 * their logical ids in the root stack for a safe, in-place cutover.
 */
module.exports = (resource, logicalId) => {
  const domainStacks = {
    MembersApi: 'ApiMembers',
    ContentApi: 'ApiContent',
    CommunityApi: 'ApiCommunity',
    TenantApi: 'ApiTenant',
    SaasApi: 'ApiSaas'
  };

  for (const [prefix, destination] of Object.entries(domainStacks)) {
    if (logicalId.startsWith(prefix) || logicalId === `HttpApiIntegration${prefix}`) {
      return { destination };
    }
  }

  const isSecretariatResource =
    logicalId.startsWith('SecretariatHandler') ||
    logicalId.startsWith('PublicDocumentVerification') ||
    logicalId === 'HttpApiIntegrationSecretariatHandler' ||
    logicalId === 'HttpApiIntegrationPublicDocumentVerification' ||
    logicalId.startsWith('HttpApiRouteAnySecretariat') ||
    logicalId.startsWith('HttpApiRouteGetPublicSecretariatDocuments');

  const isStudioExperienceResource =
    logicalId.startsWith('GetStudioPreferences') ||
    logicalId.startsWith('UpdateStudioPreferences') ||
    logicalId.startsWith('StudioGlobalSearch') ||
    logicalId === 'HttpApiIntegrationGetStudioPreferences' ||
    logicalId === 'HttpApiIntegrationUpdateStudioPreferences' ||
    logicalId === 'HttpApiIntegrationStudioGlobalSearch' ||
    logicalId.startsWith('HttpApiRouteGetStudioPreferences') ||
    logicalId.startsWith('HttpApiRoutePutStudioPreferences') ||
    logicalId.startsWith('HttpApiRouteGetStudioSearch');

  const isCorsPreflightResource =
    logicalId.startsWith('CorsPreflight') ||
    logicalId === 'HttpApiIntegrationCorsPreflight' ||
    /^HttpApiRouteOptions(Pastoral|Ministries|Volunteers|Kids|Financial|SaasInvoices|Secretariat|Studio)/.test(logicalId);

  if (isSecretariatResource || isStudioExperienceResource || isCorsPreflightResource) {
    return { destination: 'ApiExtensions' };
  }
};
