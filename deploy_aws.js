// Ambos os stages legados (dev/prod) atendem produção. Nunca escolher um por padrão.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { validateDeployment } = require('./scripts/backend-deploy-policy.cjs');
try {
  const { manifest, args } = validateDeployment(process.argv.slice(2), __dirname);
  require('./scripts/check-dependency-policy.cjs').checkDependencyPolicy(__dirname);
  require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
  const env = { ...process.env, CI: '1', AWS_REGION: manifest.region, AWS_DEFAULT_REGION: manifest.region, AWS_PAGER: '', SLS_TELEMETRY_DISABLED: '1', SERVERLESS_UPDATE_NOTIFIER_DISABLED: '1' };
  let identity;
  try {
    identity = JSON.parse(execFileSync('aws', ['sts', 'get-caller-identity', '--output', 'json'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch { throw new Error('Não foi possível validar a identidade AWS.'); }
  if (identity.Account !== manifest.account) throw new Error('Credenciais de outra conta AWS.');
  const auditDir = path.join(__dirname, '.release-evidence', manifest.releaseId);
  fs.mkdirSync(auditDir, { recursive: true });
  const auditPath = path.join(auditDir, 'backend.json');
  if (fs.existsSync(auditPath)) throw new Error('releaseId já utilizado; consulte a evidência antes de repetir.');
  const audit = { startedAt: new Date().toISOString(), operator: identity.Arn, manifest, status: 'VALIDATING' };
  const save = () => fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2) + '\n');
  save();
  for (const [cwd, command, argv] of [[__dirname, 'npx', ['--no-install', 'tsc', '--noEmit']], [__dirname, 'npm', ['test']], [path.join(__dirname, '../faith-hub-web'), 'npm', ['run', 'build']], [path.join(__dirname, '../faith-hub-pwa'), 'npm', ['run', 'build']]]) {
    try { execFileSync(command, argv, { cwd, env, stdio: 'inherit' }); }
    catch { audit.status = 'VALIDATION_FAILED'; save(); throw new Error('Validação bloqueou o deploy.'); }
  }
  // A revisão de impacto da stack é um gate operacional descrito no documento.
  validateDeployment(process.argv.slice(2), __dirname);
  audit.status = 'DEPLOYING'; save();
  const child = spawn(path.join(__dirname, 'node_modules/.bin/serverless'), args, { env, stdio: 'inherit', cwd: __dirname });
  child.on('error', () => { audit.status = 'FAILED_TO_START'; save(); process.exitCode = 1; });
  child.on('close', code => { audit.status = code === 0 ? 'DEPLOYED_PENDING_HOMOLOGATION' : 'DEPLOY_FAILED'; audit.finishedAt = new Date().toISOString(); save(); process.exitCode = code ?? 1; });
} catch (error) { console.error(error.message); process.exitCode = 1; }
