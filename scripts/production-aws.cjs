const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { REGION } = require('./production-release-policy.cjs');
// Arquivo temporário privado: evita segredos em argumentos do processo e remove em finally.
function aws(service, operation, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faith-aws-'));
  const file = path.join(dir, 'input.json');
  try {
    if (data) fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
    return JSON.parse(execFileSync('aws', [service, operation, '--region', REGION, '--output', 'json', ...(data ? ['--cli-input-json', 'file://' + file] : [])], {
      encoding: 'utf8', env: { ...process.env, AWS_PAGER: '' }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024
    }));
  } catch { throw new Error('AWS falhou: ' + service + ' ' + operation + '. Consulte o console; nenhum segredo é impresso.'); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
module.exports = { aws };
