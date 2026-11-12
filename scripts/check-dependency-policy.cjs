const fs = require('node:fs');
const path = require('node:path');
function blockedDependencies(lock) {
  return Object.entries(lock.packages || {}).filter(([key, item]) =>
    /(^|\/)node_modules\/plain-crypto-js$/.test(key) ||
    (/(^|\/)node_modules\/axios$/.test(key) && ['1.14.1', '0.30.4'].includes(item.version))
  ).map(([key, item]) => ({ path: key, version: item.version }));
}
function checkDependencyPolicy(cwd) {
  const lock = JSON.parse(fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8'));
  if (lock.lockfileVersion < 2 || !lock.packages) throw new Error('Lockfile sem inventário de pacotes verificável.');
  const blocked = blockedDependencies(lock);
  if (blocked.length) throw new Error('Dependência comprometida bloqueada antes da instalação: ' + JSON.stringify(blocked));
}
module.exports = { blockedDependencies, checkDependencyPolicy };
if (require.main === module) { try { checkDependencyPolicy(process.cwd()); console.log('Política de dependências verificada.'); } catch (e) { console.error(e.message); process.exitCode = 1; } }
