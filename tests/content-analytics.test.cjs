const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('content intelligence is tenant-scoped, feature-gated and excludes Bible', () => {
  const source = read('src/functions/contentAnalytics.ts');
  const routes = read('src/functions/contentApi.ts');
  assert.match(source, /enforceTenant\(auth\.user/);
  assert.match(source, /evaluateTenantFlags/);
  assert.match(source, /content\.analytics_dashboard/);
  assert.match(source, /organization_id = \?/);
  assert.doesNotMatch(source, /content_type[^\n]*BIBLE/);
  assert.match(routes, /GET \/CONTENT\/ANALYTICS/);
});

test('public engagement submission is rate-limited, allowlisted and privacy-preserving', () => {
  const source = read('src/functions/contentAnalytics.ts');
  assert.match(source, /checkRateLimit/);
  assert.match(source, /CONTENT_TYPES/);
  assert.match(source, /EVENT_TYPES/);
  assert.match(source, /createHash\('sha256'\)/);
  assert.match(source, /INSERT IGNORE INTO content_engagement_events/);
  assert.doesNotMatch(source, /requestIp|x-forwarded-for/);
});

test('private analytics route requires Cognito while behavioral collection remains public', () => {
  const serverless = read('serverless.yml');
  const privateBlock = serverless.match(/getContentAnalytics:[\s\S]*?(?=\n  \w|$)/)?.[0] || '';
  const publicBlock = serverless.match(/trackContentEngagement:[\s\S]*?(?=\n  \w|$)/)?.[0] || '';
  assert.match(privateBlock, /authorizer: cognitoAuthorizer/);
  assert.doesNotMatch(publicBlock, /authorizer: cognitoAuthorizer/);
});
