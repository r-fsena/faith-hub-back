process.env.AWS_EC2_METADATA_DISABLED = 'true';
delete process.env.RATE_LIMIT_TABLE;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => module._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText,
  filename
);

const { checkRateLimit } = require('../src/services/rateLimiter.ts');

function event(sourceIp, forwardedFor) {
  return {
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    requestContext: { http: { sourceIp } }
  };
}

test('rate limiter counts requests and never exposes the client IP', async () => {
  const prefix = `test-${Date.now()}-count`;
  assert.equal((await checkRateLimit(event('203.0.113.10'), { maxRequests: 2, windowSeconds: 60, identifierPrefix: prefix })).allowed, true);
  assert.equal((await checkRateLimit(event('203.0.113.10'), { maxRequests: 2, windowSeconds: 60, identifierPrefix: prefix })).remaining, 0);
  const blocked = await checkRateLimit(event('203.0.113.10'), { maxRequests: 2, windowSeconds: 60, identifierPrefix: prefix });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.errorResponse.statusCode, 429);
  assert.equal(blocked.errorResponse.body.includes('203.0.113.10'), false);
});

test('API Gateway source IP takes precedence over a spoofed forwarded header', async () => {
  const prefix = `test-${Date.now()}-source`;
  assert.equal((await checkRateLimit(event('198.51.100.20', '1.1.1.1'), { maxRequests: 1, windowSeconds: 60, identifierPrefix: prefix })).allowed, true);
  const blocked = await checkRateLimit(event('198.51.100.20', '8.8.8.8'), { maxRequests: 1, windowSeconds: 60, identifierPrefix: prefix });
  assert.equal(blocked.allowed, false);
});

test('deployment contract removes plaintext database credentials', () => {
  const config = fs.readFileSync(require('node:path').join(__dirname, '../serverless.yml'), 'utf8');
  const providerEnvironment = config.split('\n  environment:')[1].split('\n  iam:')[0];
  assert.ok(providerEnvironment.includes('DB_SECRET_ARN'));
  assert.equal(providerEnvironment.includes('DB_PASSWORD'), false);
  assert.equal(providerEnvironment.includes('DB_USER'), false);
  assert.ok(config.includes('RATE_LIMIT_TABLE'));
  assert.ok(config.includes('AWS::DynamoDB::Table'));
});
