const { execFileSync } = require('node:child_process');

const ACCOUNT = '896884286429';
const REGION = 'us-east-2';
const APPS = Object.freeze({
  studio: { id: 'd2lyt83fsceg0b', repo: 'faith-hub-web', remote: 'https://github.com/r-fsena/faith-hub-web' },
  pwa: { id: 'd312p1jp7kl7kp', repo: 'faith-hub-pwa', remote: 'https://github.com/r-fsena/faith-hub-pwa' },
  site: { id: 'dcd98qkjlz7f5', repo: 'faith-hub-site', remote: 'https://github.com/r-fsena/faith-hub-site' }
});
const REPOS = ['faith-hub-backend', 'faith-hub-web', 'faith-hub-pwa', 'faith-hub-site'];
function ensure(ok, message) { if (!ok) throw new Error(message); }
function validateManifest(m) {
  ensure(m.schemaVersion === 1 && m.environment === 'production', 'Manifesto deve declarar schemaVersion=1 e environment=production.');
  ensure(m.account === ACCOUNT && m.region === REGION, 'Conta/região de produção incorretas.');
  ensure(/^[a-zA-Z0-9][a-zA-Z0-9._-]{5,79}$/.test(m.releaseId || ''), 'releaseId inválido.');
  ensure(typeof m.approvalReference === 'string' && m.approvalReference.trim().length >= 10, 'Informe a referência da autorização explícita.');
  ensure(typeof m.ciReference === 'string' && m.ciReference.trim().length >= 10, 'Informe a referência dos checks de CI revisados.');
  ensure(typeof m.rollback === 'string' && m.rollback.trim().length >= 10, 'Descreva a reversão.');
  ensure(m.commits && REPOS.every(r => /^[a-f0-9]{40}$/.test(m.commits[r] || '')), 'Fixe SHA completo dos quatro repositórios.');
  ensure(Array.isArray(m.targets) && m.targets.length > 0 && new Set(m.targets).size === m.targets.length && m.targets.every(t => typeof t === 'string' && Object.hasOwn(APPS, t)), 'targets aceita apenas studio, pwa e site, sem duplicatas.');
  return m;
}
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function checkCheckout(cwd, expected) {
  ensure(git(cwd, 'rev-parse', 'HEAD') === expected, 'Checkout diverge do SHA aprovado: ' + cwd);
  ensure(!git(cwd, 'status', '--porcelain', '--untracked-files=normal'), 'Checkout contém alterações não versionadas: ' + cwd);
}
function checkRemote(cwd, app, expected) {
  const remote = git(cwd, 'remote', 'get-url', 'origin');
  ensure(remote.replace(/\.git$/, '') === app.remote || remote === app.remote.replace('https://github.com/', 'git@github.com:') + '.git', 'origin inesperado.');
  ensure(git(cwd, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0] === expected, 'main remota diverge do SHA aprovado.');
}
module.exports = { ACCOUNT, REGION, APPS, REPOS, ensure, validateManifest, git, checkCheckout, checkRemote };
