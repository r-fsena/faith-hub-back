/**
 * Keeps the root CloudFormation stack below AWS' 500-resource limit.
 *
 * These match only the CORS preflight and Secretariat resources introduced
 * after the currently deployed template. Existing functions are intentionally
 * left in place so this change cannot force their replacement.
 */
module.exports = (resource, logicalId) => {
  const isSecretariatResource =
    logicalId.startsWith('SecretariatHandler') ||
    logicalId === 'HttpApiIntegrationSecretariatHandler' ||
    logicalId.startsWith('HttpApiRouteAnySecretariat');

  const isCorsPreflightResource =
    logicalId.startsWith('CorsPreflight') ||
    logicalId === 'HttpApiIntegrationCorsPreflight' ||
    /^HttpApiRouteOptions(Pastoral|Ministries|Volunteers|Kids|Financial|SaasInvoices|Secretariat)/.test(logicalId);

  if (isSecretariatResource || isCorsPreflightResource) {
    return { destination: 'ApiExtensions' };
  }
};
