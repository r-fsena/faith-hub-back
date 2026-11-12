#!/usr/bin/env node
// Controle operacional manual. Não substitui aprovação imposta por IAM/CI.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { aws } = require('./production-aws.cjs');
const { checkDependencyPolicy } = require('./check-dependency-policy.cjs');
const { ACCOUNT, REGION, APPS, REPOS, ensure, validateManifest, checkCheckout, checkRemote } = require('./production-release-policy.cjs');

function main() {
  const args = process.argv.slice(2);
  ensure(args.length === 4 || (args.length === 5 && args[4] === '--apply'), 'Uso: node scripts/release-amplify.cjs --manifest arquivo.json --workspace /caminho/ecossistema [--apply]');
  ensure(args[0] === '--manifest' && args[2] === '--workspace', 'Parâmetros inválidos.');
  const m = validateManifest(JSON.parse(fs.readFileSync(args[1], 'utf8')));
  const workspace = path.resolve(args[3]);
  ensure(fs.realpathSync(path.join(__dirname, '..')) === fs.realpathSync(path.join(workspace, 'faith-hub-backend')), 'Execute a ferramenta do próprio checkout de liberação.');
  const applying = args[4] === '--apply';
  for (const repo of REPOS) checkDependencyPolicy(path.join(workspace, repo));
  const identity = aws('sts', 'get-caller-identity');
  ensure(identity.Account === ACCOUNT, 'Credenciais pertencem a outra conta AWS.');
  for (const repo of REPOS) checkCheckout(path.join(workspace, repo), m.commits[repo]);
  function inspect(target) {
    const app = APPS[target];
    const cwd = path.join(workspace, app.repo);
    checkRemote(cwd, app, m.commits[app.repo]);
    // O guard no build verifica o SHA real do checkout, inclusive em jobs com commitId=HEAD.
    ensure(fs.readFileSync(path.join(cwd, 'amplify.yml'), 'utf8').includes('node scripts/verify-production-release.cjs'), 'Build sem guard de produção.');
    const settings = aws('amplify', 'get-app', { appId: app.id }).app;
    ensure(!settings.enableBranchAutoBuild && !settings.enableAutoBranchCreation, 'Automações do app devem estar desligadas.');
    ensure(settings.repository.replace(/\.git$/, '') === app.remote, 'Repositório Amplify inesperado.');
    const branch = aws('amplify', 'get-branch', { appId: app.id, branchName: 'main' }).branch;
    ensure(branch.stage === 'PRODUCTION' && !branch.enableAutoBuild && !branch.enablePullRequestPreview, 'Branch de produção sem proteção.');
    const jobs = aws('amplify', 'list-jobs', { appId: app.id, branchName: 'main', maxResults: 50 }).jobSummaries;
    ensure(!jobs.some(j => ['CREATED', 'PENDING', 'PROVISIONING', 'RUNNING', 'CANCELLING'].includes(j.status)), 'Há job ativo; aguarde antes de publicar.');
    return branch;
  }
  for (const target of m.targets) inspect(target);
  if (!applying) {
    console.log(JSON.stringify({ mode: 'PLAN', release: m.releaseId, targets: m.targets, account: identity.Account, note: 'Sem alteração AWS. Aplicação executará os gates antes de iniciar jobs. Aprovação/CI são referências declaradas pelo operador.' }, null, 2));
    return;
  }
  const auditDir = path.join(workspace, 'faith-hub-backend', '.release-evidence', m.releaseId);
  fs.mkdirSync(auditDir, { recursive: true });
  const audit = { releaseId: m.releaseId, startedAt: new Date().toISOString(), operator: identity.Arn, manifest: m, jobs: [], status: 'VALIDATING' };
  const save = () => fs.writeFileSync(path.join(auditDir, 'release.json'), JSON.stringify(audit, null, 2) + '\n');
  ensure(!fs.existsSync(path.join(auditDir, 'release.json')), 'releaseId já utilizado; consulte a evidência antes de tentar novamente.');
  save();
  try {
    const checks = [
      ['faith-hub-backend', 'npx', ['--no-install', 'tsc', '--noEmit']],
      ['faith-hub-web', 'npm', ['run', 'build']],
      ['faith-hub-pwa', 'npm', ['run', 'build']],
      ...(m.targets.includes('site') ? [['faith-hub-site', 'npm', ['run', 'build']]] : [])
    ];
    for (const [repo, command, argv] of checks) {
      const fd = fs.openSync(path.join(auditDir, repo + '-check.log'), 'w');
      try { execFileSync(command, argv, { cwd: path.join(workspace, repo), stdio: ['ignore', fd, fd] }); }
      finally { fs.closeSync(fd); }
    }
    for (const repo of REPOS) checkCheckout(path.join(workspace, repo), m.commits[repo]);
    audit.status = 'STARTING'; save();
    for (const target of m.targets) {
      const app = APPS[target];
      const branch = inspect(target); // Revalida main e jobs após os gates.
      aws('amplify', 'update-branch', { appId: app.id, branchName: 'main', enableAutoBuild: false, environmentVariables: {
        ...branch.environmentVariables,
        FAITH_PRODUCTION_RELEASE_ID: m.releaseId,
        FAITH_PRODUCTION_RELEASE_COMMIT: m.commits[app.repo]
      } });
      const job = aws('amplify', 'start-job', { appId: app.id, branchName: 'main', jobType: 'RELEASE', jobReason: m.releaseId }).jobSummary;
      audit.jobs.push({ target, appId: app.id, jobId: job.jobId, status: job.status, expectedCommit: m.commits[app.repo] }); save();
    }
    audit.status = 'JOBS_STARTED'; save();
    console.log(JSON.stringify({ status: audit.status, jobs: audit.jobs, auditDir, note: 'Acompanhe cada job até SUCCEED e homologue a versão. Jobs iniciados não significam publicação concluída.' }, null, 2));
  } catch (error) {
    audit.status = 'FAILED_OR_PARTIAL'; audit.error = error.message; save(); throw error;
  }
}
if (require.main === module) { try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; } }
