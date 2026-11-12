const fs = require('node:fs');
const { ACCOUNT, REGION, ensure, checkCheckout } = require('./production-release-policy.cjs');

function validateDeployment(argv, cwd) {
  ensure(argv[0] === '--release-manifest' && argv[2] === '--confirm-production', 'Deploy direto bloqueado. Use --release-manifest arquivo.json --confirm-production RELEASE_ID deploy --stage DESTINO --config ARQUIVO. Consulte docs/FLUXO_IMPLEMENTACAO_E_PUBLICACAO.md.');
  const m = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
  const args = argv.slice(4);
  ensure(m.schemaVersion === 1 && m.environment === 'production' && m.kind === 'backend-emergency', 'Manifesto emergencial de backend inválido.');
  ensure(m.account === ACCOUNT && m.region === REGION, 'Conta/região incorretas.');
  ensure(/^[a-zA-Z0-9][a-zA-Z0-9._-]{5,79}$/.test(m.releaseId || '') && argv[3] === m.releaseId, 'Confirmação não corresponde ao releaseId.');
  ensure(/^[a-f0-9]{40}$/.test(m.commit || ''), 'Fixe SHA completo do backend.');
  for (const key of ['approvalReference', 'changeReviewReference', 'rollback']) ensure(typeof m[key] === 'string' && m[key].trim().length >= 10, 'Campo obrigatório: ' + key);
  ensure(args.length === 5 && args[0] === 'deploy' && args[1] === '--stage' && args[2] === m.stage && args[3] === '--config' && args[4] === m.config, 'Use somente deploy --stage STAGE --config CONFIG, correspondente ao manifesto.');
  ensure((['dev', 'prod'].includes(m.stage) && m.config === 'serverless.yml') || (m.stage === 'live' && m.config === 'serverless-ops.yml'), 'Combinação de stage/config não autorizada.');
  checkCheckout(cwd, m.commit);
  return { manifest: m, args };
}
module.exports = { validateDeployment };
