const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(backendRoot, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

test('AWS runtime and production stack strategy stay inside supported operational boundaries', () => {
  const serverless = read('faith-hub-backend/serverless.yml');
  const database = read('faith-hub-backend/src/db/index.ts');
  const rateLimiter = read('faith-hub-backend/src/services/rateLimiter.ts');
  assert.match(serverless, /runtime:\s+nodejs22\.x/);
  assert.match(serverless, /prod:\s*\n\s+splitStacksPerType:\s+false\s*\n\s+splitStacksPerGroupFunction:\s+true/);
  assert.match(serverless, /nestedStackCount:\s+20/);
  assert.doesNotMatch(serverless, /- asaas-access-token/);
  assert.doesNotMatch(database, /Access-Control-Allow-Origin': '\*'/);
  assert.doesNotMatch(rateLimiter, /Access-Control-Allow-Origin': '\*'/);
});

test('private Studio reads include Cognito authorization headers', () => {
  const financial = read('faith-hub-web/src/modules/FinancialTreasury.tsx');
  const cells = read('faith-hub-web/src/modules/CellGroups.tsx');
  const kids = read('faith-hub-web/src/modules/KidsMinistry.tsx');
  const secretariat = read('faith-hub-web/src/modules/Secretariat.tsx');
  const secretariatPhase2 = read('faith-hub-web/src/modules/SecretariatPhase2.tsx');

  assert.match(financial, /financial\/transactions\?\$\{params\.toString\(\)\}`, \{ headers \}/);
  assert.match(financial, /financial\/summary\?\$\{params\.toString\(\)\}`, \{ headers \}/);
  assert.match(cells, /members\?organization_id=\$\{orgId\}\$\{campusParam\}`, \{ headers \}/);
  assert.match(kids, /kids\/rooms\?organization_id=.*\{ headers \}/);
  assert.match(secretariat, /secretariat\/dashboard\?.*\{ headers \}/);
  assert.match(secretariat, /secretariat\/records\?.*\{ headers \}/);
  assert.match(secretariat, /useFeatureFlags\(\)/);
  assert.match(secretariatPhase2, /getAuthHeaders\(\)/);
  for (const resource of ['movements', 'requests', 'documents', 'baptisms', 'templates', 'signatories']) {
    assert.match(secretariatPhase2, new RegExp(`['\\\"]${resource}['\\\"]`));
  }
});

test('sensitive QR codes stay on-device and demo authentication is production-gated', () => {
  const sensitiveQrFiles = [
    'faith-hub-web/src/components/KidsBadgeModal.tsx',
    'faith-hub-pwa/src/components/KidsBadgeModal.tsx',
    'faith-hub-pwa/src/components/EventTicketPassModal.tsx'
  ];
  for (const file of sensitiveQrFiles) {
    const source = read(file);
    assert.match(source, /QRCode\.toDataURL/);
    assert.doesNotMatch(source, /api\.qrserver\.com/);
  }

  const studio = read('faith-hub-web/src/App.tsx');
  const pwaAuth = read('faith-hub-pwa/src/context/AuthContext.tsx');
  assert.match(studio, /VITE_ENABLE_DEMO_AUTH/);
  assert.match(pwaAuth, /DEMO_AUTH_ENABLED/);
});

test('Amplify applications define baseline security response headers', () => {
  for (const app of ['faith-hub-web', 'faith-hub-pwa', 'faith-hub-site']) {
    const headers = read(`${app}/customHttp.yml`);
    assert.match(headers, /Strict-Transport-Security/);
    assert.match(headers, /X-Content-Type-Options/);
    assert.match(headers, /Referrer-Policy/);
    assert.match(headers, /Permissions-Policy/);
  }
});

test('production cutover remains configurable and the Asaas webhook can move safely', () => {
  const webhookSync = read('faith-hub-backend/scripts/sync-asaas-webhook.cjs');
  const auditLogs = read('faith-hub-web/src/modules/SecurityAuditLogs.tsx');
  assert.match(webhookSync, /ASAAS_WEBHOOK_SOURCE_URL/);
  assert.match(webhookSync, /GetSecretValueCommand/);
  assert.match(webhookSync, /ASAAS_WEBHOOK_URL_NOT_UPDATED/);
  assert.match(auditLogs, /import\.meta\.env\.VITE_API_URL/);
});

test('authenticated aggregate routes expose unauthenticated CORS preflight only', () => {
  const serverless = read('faith-hub-backend/serverless.yml');
  const preflight = read('faith-hub-backend/src/functions/corsPreflight.ts');
  for (const route of ['pastoral', 'ministries', 'volunteers', 'kids', 'financial', 'saas/invoices', 'secretariat', 'studio']) {
    const escaped = route.replace('/', '\\/');
    assert.match(serverless, new RegExp(`method: OPTIONS\\s+path: \\/${escaped}(?:\\/\\{proxy\\+\\})?`));
  }
  assert.match(preflight, /statusCode:\s*204/);
  assert.doesNotMatch(preflight, /Access-Control-Allow-Origin/);
});

test('new aggregate API resources stay outside the CloudFormation root limit', () => {
  const stackMap = read('faith-hub-backend/stacks-map.js');
  assert.match(stackMap, /SecretariatHandler/);
  assert.match(stackMap, /StudioGlobalSearch/);
  assert.match(stackMap, /CorsPreflight/);
  assert.match(stackMap, /destination: 'ApiExtensions'/);
});

test('Studio phases 3 and 4 stay tenant-scoped, authorized and feature-gated', () => {
  const serverless = read('faith-hub-backend/serverless.yml');
  const handler = read('faith-hub-backend/src/functions/studioExperience.ts');
  const service = read('faith-hub-web/src/services/studioExperience.ts');
  const context = read('faith-hub-web/src/context/StudioExperienceContext.tsx');
  const palette = read('faith-hub-web/src/components/StudioCommandPalette.tsx');
  const onboarding = read('faith-hub-web/src/components/StudioOnboarding.tsx');

  for (const functionName of ['getStudioPreferences', 'updateStudioPreferences', 'studioGlobalSearch']) {
    const block = serverless.split(`\n  ${functionName}:`)[1].split(/\n  \w+:/)[0];
    assert.match(block, /authorizer: cognitoAuthorizer/);
    assert.match(block, /path: \/studio\//);
  }
  assert.match(handler, /requireAuth\(event\)/);
  assert.match(handler, /enforceRole\(auth\.user, allowedRoles\)/);
  assert.match(handler, /enforceTenant\(auth\.user, requestedOrg\)/);
  assert.match(handler, /WHERE organization_id = \? AND user_id = \?/);
  assert.match(handler, /m\.organization_id = \?/);
  assert.match(handler, /d\.organization_id = \?/);
  for (const flag of ['studio.guided_onboarding', 'studio.global_search', 'studio.personalized_navigation']) {
    assert.match(handler, new RegExp(flag.replace('.', '\\.')));
    assert.match(context, new RegExp(flag.replace('.', '\\.')));
  }
  assert.match(service, /getAuthHeaders\(\)/);
  assert.match(palette, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(palette, /searchStudio\(/);
  assert.match(palette, /destination\.roles/);
  assert.match(palette, /isFeatureEnabled\(destination\.featureFlag\)/);
  assert.match(onboarding, /onboardingSteps/);
  assert.match(onboarding, /setStepCompleted/);
});

test('public Secretariat verification is explicitly rate-limited and feature-gated', () => {
  const serverless = read('faith-hub-backend/serverless.yml');
  const verification = read('faith-hub-backend/src/functions/publicDocumentVerification.ts');
  const templateStudio = read('faith-hub-web/src/modules/SecretariatTemplateStudio.tsx');
  const pdf = read('faith-hub-web/src/services/secretariatDocumentPdf.ts');
  const block = serverless.split('\n  publicDocumentVerification:')[1].split(/\n  \w+:/)[0];
  assert.match(block, /path: \/public\/secretariat\/documents\/\{token\}/);
  assert.doesNotMatch(block, /authorizer:/);
  assert.match(verification, /checkRateLimit\(/);
  assert.match(verification, /secretariat\.public_verification/);
  assert.match(verification, /d\.organization_id = \?/);
  assert.match(templateStudio, /PENDING_APPROVAL/);
  assert.match(templateStudio, /copy-campus/);
  assert.match(pdf, /QRCode\.toDataURL/);
  assert.match(pdf, /crypto\.subtle\.digest\('SHA-256'/);
  assert.match(pdf, /application\/pdf/);
});
