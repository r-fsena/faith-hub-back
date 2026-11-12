const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { validateManifest, REPOS, APPS } = require('../scripts/production-release-policy.cjs');
const { validateDeployment } = require('../scripts/backend-deploy-policy.cjs');
const sha = 'a'.repeat(40);
const valid = () => ({ schemaVersion: 1, environment: 'production', account: '896884286429', region: 'us-east-2', releaseId: 'FH-20261112-001', approvalReference: 'Autorização explícita no chamado 123', ciReference: 'Checks CI do release no chamado 123', rollback: 'Reverter pelo commit anterior validado', commits: Object.fromEntries(REPOS.map(r => [r, sha])), targets: ['pwa'] });
test('manifest rejects wrong destinations, missing approval and unpinned versions', () => {
  assert.equal(validateManifest(valid()).targets[0], 'pwa');
  for (const patch of [{ environment: 'dev' }, { account: '000000000000' }, { region: 'us-east-1' }, { approvalReference: '' }, { ciReference: '' }, { targets: ['backend'] }, { targets: ['__proto__'] }, { targets: ['constructor'] }, { targets: ['pwa', 'pwa'] }, { commits: { 'faith-hub-pwa': 'main' } }]) assert.throws(() => validateManifest({ ...valid(), ...patch }));
});
test('backend entrypoint refuses implicit and legacy direct deployment before any AWS call', () => {
  for (const argv of [[], ['deploy'], ['deploy', '--stage', 'dev'], ['deploy', '--config', 'serverless-ops.yml', '--stage', 'live']]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../deploy_aws.js'), ...argv], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
    assert.equal(result.status, 1); assert.match(result.stderr, /Deploy direto bloqueado/);
  }
});
test('backend emergency manifest must match exact clean checkout, explicit stage and config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faith-release-test-'));
  const manifestFile = path.join(os.tmpdir(), 'faith-release-' + path.basename(dir) + '.json');
  const git = (...argv) => execFileSync('git', argv, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.name', 'Release Test'); git('config', 'user.email', 'release@example.invalid');
    fs.writeFileSync(path.join(dir, 'tracked'), 'test'); git('add', 'tracked'); git('commit', '-qm', 'fixture');
    const m = { ...valid(), kind: 'backend-emergency', commit: git('rev-parse', 'HEAD'), stage: 'dev', config: 'serverless.yml', changeReviewReference: 'Revisão da stack no chamado 123' };
    fs.writeFileSync(manifestFile, JSON.stringify(m));
    const argv = ['--release-manifest', manifestFile, '--confirm-production', m.releaseId, 'deploy', '--stage', 'dev', '--config', 'serverless.yml'];
    assert.equal(validateDeployment(argv, dir).manifest.stage, 'dev');
    assert.throws(() => validateDeployment(argv.map(v => v === 'dev' ? 'prod' : v), dir));
    assert.throws(() => validateDeployment([...argv, '--force'], dir));
    fs.writeFileSync(path.join(dir, 'tracked'), 'modified'); assert.throws(() => validateDeployment(argv, dir), /não versionadas/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(manifestFile, { force: true }); }
});
test('frontend guards require correct app, branch, release and actual Git SHA even when AWS reports HEAD', () => {
  for (const [target, app] of Object.entries(APPS)) {
    const file = path.join(__dirname, '../../', app.repo, 'scripts/verify-production-release.cjs');
    // No CI do backend, os frontends são outros repositórios. Testes locais incluem os três guards.
    if (!fs.existsSync(file)) continue;
    const { verify } = require(file);
    const env = { AWS_APP_ID: app.id, AWS_BRANCH: 'main', AWS_COMMIT_ID: 'HEAD', FAITH_PRODUCTION_RELEASE_ID: 'FH-20261112-001', FAITH_PRODUCTION_RELEASE_COMMIT: sha };
    assert.doesNotThrow(() => verify(env, () => sha), target);
    for (const patch of [{ AWS_APP_ID: 'wrong-app' }, { AWS_BRANCH: 'develop' }, { FAITH_PRODUCTION_RELEASE_ID: '' }, { FAITH_PRODUCTION_RELEASE_COMMIT: '' }]) assert.throws(() => verify({ ...env, ...patch }, () => sha));
    assert.throws(() => verify(env, () => 'b'.repeat(40)), /commit aprovado/);
  }
});
