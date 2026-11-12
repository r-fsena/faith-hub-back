#!/usr/bin/env node
// Sem --apply: apenas consulta. Altera somente controles de publicação automática.
const fs = require('node:fs');
const { aws } = require('./production-aws.cjs');
const { ACCOUNT, REGION, APPS, ensure } = require('./production-release-policy.cjs');
function main() {
  const args = process.argv.slice(2);
  ensure((args.length === 2 || (args.length === 3 && args[2] === '--apply')) && args[0] === '--output', 'Uso: node scripts/freeze-production-publishing.cjs --output evidencias.json [--apply]');
  const applying = args[2] === '--apply';
  ensure(!fs.existsSync(args[1]), 'Arquivo de evidência já existe; não sobrescrever.');
  const identity = aws('sts', 'get-caller-identity');
  ensure(identity.Account === ACCOUNT, 'Conta AWS incorreta.');
  const audit = { capturedAt: new Date().toISOString(), operator: identity.Arn, account: ACCOUNT, region: REGION, mode: applying ? 'APPLY' : 'PLAN', apps: [] };
  const save = () => fs.writeFileSync(args[1], JSON.stringify(audit, null, 2) + '\n');
  const snapshot = app => {
    const a = aws('amplify', 'get-app', { appId: app.id }).app;
    ensure(a.repository.replace(/\.git$/, '') === app.remote, 'Repositório inesperado.');
    const bs = aws('amplify', 'list-branches', { appId: app.id }).branches;
    const webhooks = aws('amplify', 'list-webhooks', { appId: app.id }).webhooks;
    return { appId: app.id, autoBuild: a.enableBranchAutoBuild, autoBranchCreation: a.enableAutoBranchCreation,
      webhooks: webhooks.map(w => ({ id: w.webhookId, branch: w.branchName })),
      branches: bs.map(b => ({ name: b.branchName, autoBuild: b.enableAutoBuild, preview: b.enablePullRequestPreview })) };
  };
  for (const [name, app] of Object.entries(APPS)) audit.apps.push({ name, before: snapshot(app) });
  // Webhooks externos podem iniciar releases; exigem avaliação explícita antes de afirmar bloqueio completo.
  ensure(audit.apps.every(a => !a.before.webhooks.length), 'Há webhooks de build externos. Revise-os antes de aplicar.');
  save();
  if (applying) {
    try {
      for (const entry of audit.apps) {
        const app = APPS[entry.name];
        aws('amplify', 'update-app', { appId: app.id, enableBranchAutoBuild: false, enableAutoBranchCreation: false });
        for (const b of entry.before.branches) aws('amplify', 'update-branch', { appId: app.id, branchName: b.name, enableAutoBuild: false, enablePullRequestPreview: false });
        entry.after = snapshot(app); save();
        ensure(!entry.after.autoBuild && !entry.after.autoBranchCreation && entry.after.branches.every(b => !b.autoBuild && !b.preview), 'Verificação da proteção falhou.');
      }
      audit.status = 'VERIFIED';
    } catch (error) { audit.status = 'FAILED_OR_PARTIAL'; audit.error = error.message; save(); throw error; }
  } else audit.status = 'READ_ONLY';
  save(); console.log(JSON.stringify({ status: audit.status, apps: audit.apps.map(a => ({ name: a.name, state: a.after || a.before })), output: args[1] }, null, 2));
}
if (require.main === module) { try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; } }
