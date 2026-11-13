const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { configurationHash } = require('../scripts/release-lambda-code.cjs');

test('code-only release detects configuration drift without exposing environment values', () => {
  const baseline = { Handler: 'src/functions/financial.handler', Runtime: 'nodejs22.x', Environment: { Variables: { DB_HOST: 'private.example', TOKEN: 'private-value' } }, Role: 'existing-role' };
  const digest = configurationHash(baseline);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, configurationHash({ ...baseline, LastModified: 'ignored' }));
  assert.equal(digest, configurationHash({ Role: baseline.Role, Environment: { Variables: { TOKEN: 'private-value', DB_HOST: 'private.example' } }, Runtime: baseline.Runtime, Handler: baseline.Handler }));
  for (const change of [{ Runtime: 'nodejs20.x' }, { Role: 'other-role' }, { Environment: { Variables: { DB_HOST: 'different.example' } } }]) {
    assert.notEqual(digest, configurationHash({ ...baseline, ...change }));
  }
});

test('code-only publisher refuses missing manifest before cloud access', () => {
  const result = spawnSync(process.execPath, ['scripts/release-lambda-code.cjs'], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Uso:/);
  assert.doesNotMatch(result.stderr, /credential|AccessDenied|AWS_ACCESS/);
});
