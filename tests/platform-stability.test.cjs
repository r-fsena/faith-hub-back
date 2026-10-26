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

  assert.match(financial, /financial\/transactions\?\$\{params\.toString\(\)\}`, \{ headers \}/);
  assert.match(financial, /financial\/summary\?\$\{params\.toString\(\)\}`, \{ headers \}/);
  assert.match(cells, /members\?organization_id=\$\{orgId\}\$\{campusParam\}`, \{ headers \}/);
  assert.match(kids, /kids\/rooms\?organization_id=.*\{ headers \}/);
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
