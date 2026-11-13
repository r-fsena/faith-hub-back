const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');
const { ensure, git } = require('./production-release-policy.cjs');
const { checkDependencyPolicy } = require('./check-dependency-policy.cjs');
const affected = new Set([
  'src/functions/cellGroups.ts', 'src/functions/financial.ts', 'src/functions/intelligence.ts',
  'src/functions/kids.ts', 'src/functions/members.ts', 'src/functions/secretariatPhase2.ts',
  'src/services/memberCsvImport.ts', 'src/services/planCatalog.ts', 'src/services/planProvisioning.ts',
  'src/services/provisioningService.ts', 'src/services/publicJourney.ts',
  'src/services/featureFlagService.ts', 'src/services/intelligenceOperations.ts'
]);
async function main() {
  const args = process.argv.slice(2);
  ensure(args.length === 4 && args[0] === '--inventory' && args[2] === '--output', 'Uso: node scripts/build-foundations-artifacts.cjs --inventory funcoes.json --output diretorio-novo');
  const cwd = path.resolve(__dirname, '..');
  checkDependencyPolicy(cwd);
  const out = path.resolve(args[3]); ensure(!fs.existsSync(out), 'Não sobrescrever artefatos.'); fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const inventory = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  const report = { sourceCommit: git(cwd, 'rev-parse', 'HEAD'), builtAt: new Date().toISOString(), targets: [], artifacts: [] };
  const modules = [...new Set(inventory.filter(f => /^faith-hub-backend-(dev|prod)-/.test(f.name)).map(f => f.handler.slice(0, f.handler.lastIndexOf('.'))))];
  for (const moduleName of modules) {
    ensure(/^src\/functions\/[A-Za-z0-9_-]+$/.test(moduleName), 'Handler inesperado: ' + moduleName);
    const entry = moduleName + '.ts'; if (!fs.existsSync(path.join(cwd, entry))) continue;
    const build = await esbuild.build({ absWorkingDir: cwd, entryPoints: [entry], outfile: moduleName + '.js', bundle: true, write: false,
      metafile: true, platform: 'node', format: 'cjs', target: 'node22', external: ['sharp'], logLevel: 'silent', sourcemap: false });
    if (!Object.keys(build.metafile.inputs).some(input => affected.has(input))) continue;
    const dir = path.join(out, path.basename(moduleName)); fs.mkdirSync(path.join(dir, path.dirname(moduleName)), { recursive: true });
    const js = build.outputFiles.find(f => f.path.endsWith('.js')); ensure(js, 'Bundle ausente.');
    fs.writeFileSync(path.join(dir, moduleName + '.js'), js.contents);
    const needsSharp = Object.values(build.metafile.outputs).some(output => output.imports.some(i => i.path === 'sharp'));
    if (needsSharp) {
      const env = { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' };
      for (const key of ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','DB_PASSWORD','ASAAS_API_KEY']) delete env[key];
      execFileSync('npm', ['install','--prefix',dir,'--no-save','--ignore-scripts','--package-lock=false','--os=linux','--cpu=x64','--libc=glibc','--include=optional','sharp@0.35.5'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const nativeDir = path.join(dir, 'node_modules/@img/sharp-linux-x64/lib');
      const native = fs.existsSync(nativeDir) && fs.readdirSync(nativeDir).find(name => /^sharp-linux-x64(?:-[\d.]+)?\.node$/.test(name));
      ensure(native, 'Sharp Linux ausente.');
      const elf = fs.readFileSync(path.join(nativeDir, native));
      ensure(elf.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && elf[4] === 2 && elf[5] === 1 && elf.readUInt16LE(18) === 62, 'Sharp deve ser ELF Linux x86_64.');
    }
    const artifact = dir + '.zip';
    execFileSync('zip', ['-qr', artifact, 'src', ...(needsSharp ? ['node_modules'] : [])], { cwd: dir, stdio: ['ignore','pipe','pipe'] });
    const size = fs.statSync(artifact).size; ensure(size < 50 * 1024 * 1024, 'Artefato excede o limite de upload direto.');
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('base64');
    const item = { module: moduleName, artifact, sha256, bytes: size, nativeSharpLinux: needsSharp,
      changedInputs: Object.keys(build.metafile.inputs).filter(input => affected.has(input)) };
    report.artifacts.push(item);
    for (const fn of inventory.filter(f => f.handler.startsWith(moduleName + '.'))) report.targets.push({ ...fn, artifact, artifactSha256: sha256 });
  }
  ensure(report.targets.length > 0, 'Nenhuma função selecionada.');
  fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ sourceCommit: report.sourceCommit, modules: report.artifacts.length, functions: report.targets.length, report: path.join(out, 'build.json') }));
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
