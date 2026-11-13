// Only code of explicitly listed existing functions; never deploys infrastructure/configuration.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { aws } = require('./production-aws.cjs');
const { ACCOUNT, REGION, ensure, checkCheckout, git } = require('./production-release-policy.cjs');
const { checkDependencyPolicy } = require('./check-dependency-policy.cjs');
function ordered(value) { return Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])])) : value; }
const hash = value => crypto.createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
function configurationHash(c) {
  return hash(Object.fromEntries(['Handler','Runtime','Architectures','Role','Timeout','MemorySize','Environment','Layers','VpcConfig','FileSystemConfigs','EphemeralStorage','TracingConfig','DeadLetterConfig','KMSKeyArn','PackageType'].map(k => [k, c[k] ?? null])));
}
async function main() {
  const args = process.argv.slice(2);
  ensure((args.length === 2 || args.length === 3 && args[2] === '--apply') && args[0] === '--manifest', 'Uso: node scripts/release-lambda-code.cjs --manifest arquivo.json [--apply]');
  const m = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  ensure(m.schemaVersion === 1 && m.kind === 'lambda-code-only' && m.environment === 'production', 'Manifesto inválido.');
  ensure(m.account === ACCOUNT && m.region === REGION && /^[a-f0-9]{40}$/.test(m.commit || ''), 'Conta, região ou SHA inválidos.');
  ensure(/^[a-zA-Z0-9][a-zA-Z0-9._-]{5,79}$/.test(m.releaseId || ''), 'Release inválida.');
  for (const key of ['approvalReference', 'ciReference', 'rollback']) ensure(typeof m[key] === 'string' && m[key].length >= 10, 'Referência obrigatória: ' + key);
  const cwd = path.resolve(__dirname, '..'); checkCheckout(cwd, m.commit); checkDependencyPolicy(cwd);
  ensure(git(cwd, 'remote', 'get-url', 'origin').replace(/\.git$/, '') === 'https://github.com/r-fsena/faith-hub-back', 'Origem inesperada.');
  ensure(git(cwd, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0] === m.commit, 'main remota diverge do SHA aprovado.');
  const build = JSON.parse(fs.readFileSync(m.buildReport, 'utf8')); ensure(build.sourceCommit === m.commit, 'Artefatos de outro commit.');
  ensure(Array.isArray(m.targets) && m.targets.length > 0 && new Set(m.targets.map(t => t.name)).size === m.targets.length, 'Lista de funções inválida.');
  const actor = aws('sts', 'get-caller-identity'); ensure(actor.Account === ACCOUNT, 'Credenciais de outra conta.');
  const cfg = name => aws('lambda', 'get-function-configuration', { FunctionName: name });
  function check(t) {
    ensure(/^faith-hub-backend-(dev|prod)-[A-Za-z0-9]+$/.test(t.name), 'Função fora do escopo.');
    const artifact = build.targets.find(b => b.name === t.name);
    ensure(artifact && artifact.artifact === t.artifact && artifact.artifactSha256 === t.artifactSha256 && artifact.handler === t.handler, 'Artefato fora do build aprovado.');
    const bytes = fs.readFileSync(t.artifact); ensure(bytes.length < 50 * 1024 * 1024 && crypto.createHash('sha256').update(bytes).digest('base64') === t.artifactSha256, 'Checksum do zip divergente.');
    const current = cfg(t.name);
    ensure(current.Runtime === 'nodejs22.x' && (current.Architectures || ['x86_64']).join() === 'x86_64' && current.Handler === t.handler, 'Runtime, arquitetura ou handler divergentes.');
    ensure(current.State === 'Active' && current.LastUpdateStatus === 'Successful', 'Função indisponível ou em atualização.');
    ensure(current.CodeSha256 === t.codeSha256 && current.RevisionId === t.revisionId && configurationHash(current) === t.configurationSha256, 'Baseline mudou; revisar novamente ' + t.name);
    return current;
  }
  for (const t of m.targets) check(t);
  if (!args.includes('--apply')) { console.log(JSON.stringify({ mode: 'PLAN', release: m.releaseId, functions: m.targets.length, configurationChanges: false })); return; }
  const dir = path.join(cwd, '.release-evidence', m.releaseId); ensure(!fs.existsSync(dir), 'Release já iniciada; consultar evidência antes de repetir.'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const journal = { startedAt: new Date().toISOString(), actor: actor.Arn, commit: m.commit, release: m.releaseId, backups: [], functions: [], status: 'BACKING_UP' };
  const save = () => fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 }); save();
  try {
    // Obtain and verify ALL rollback packages before the first mutation.
    const copies = new Map();
    for (const t of m.targets) {
      check(t);
      const destination = path.join(dir, t.name + '.zip');
      if (copies.has(t.codeSha256)) fs.copyFileSync(copies.get(t.codeSha256), destination);
      else {
        const fn = aws('lambda', 'get-function', { FunctionName: t.name });
        ensure(fn.Code.Location.startsWith('https://'), 'Origem de backup inválida.');
        // Signed URL is sent on stdin, never printed or exposed in process arguments.
        const config = 'url = ' + JSON.stringify(fn.Code.Location) + '\noutput = ' + JSON.stringify(destination) + '\n';
        try { execFileSync('curl', ['--config','-','--proto','=https','--fail','--silent','--show-error','--retry','3','--retry-all-errors','--retry-delay','2','--connect-timeout','15','--max-time','300'], { input: config, timeout: 1240000, stdio: ['pipe','pipe','pipe'] }); }
        catch { throw new Error('Falha ao baixar backup de ' + t.name + '; nenhuma atualização deve iniciar sem todos os backups.'); }
        copies.set(t.codeSha256, destination);
      }
      fs.chmodSync(destination, 0o600);
      ensure(crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('base64') === t.codeSha256, 'Backup não corresponde ao baseline.');
      journal.backups.push({ name: t.name, codeSha256: t.codeSha256, verified: true }); save();
    }
    journal.status = 'UPDATING'; save();
    for (const t of m.targets) {
      check(t);
      try { execFileSync('aws', ['lambda','update-function-code','--region',REGION,'--function-name',t.name,'--revision-id',t.revisionId,'--zip-file','fileb://' + t.artifact,'--output','json'], { encoding: 'utf8', env: { ...process.env, AWS_PAGER: '' }, stdio: ['ignore','pipe','pipe'] }); }
      catch { throw new Error('Falha ao atualizar ' + t.name + '; consultar diário de publicação.'); }
      let current;
      for (let attempt = 0; attempt < 90; attempt++) {
        current = cfg(t.name); if (current.LastUpdateStatus !== 'InProgress') break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      ensure(current.LastUpdateStatus === 'Successful' && current.CodeSha256 === t.artifactSha256 && configurationHash(current) === t.configurationSha256, 'Verificação pós-publicação falhou: ' + t.name);
      journal.functions.push({ name: t.name, codeSha256: current.CodeSha256, configurationPreserved: true, status: 'VERIFIED' }); save();
    }
    journal.status = 'CODE_VERIFIED_PENDING_FUNCTIONAL_HOMOLOGATION'; save(); console.log(JSON.stringify({ status: journal.status, functions: journal.functions.length, evidence: dir }));
  } catch (e) { journal.status = 'STOPPED_OR_PARTIAL'; journal.error = e.message; save(); throw e; }
}
module.exports = { configurationHash };
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
