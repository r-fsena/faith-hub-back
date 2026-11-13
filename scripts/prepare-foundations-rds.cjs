// Apply only the documented dynamic trigger prerequisite. Never reboots RDS.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createAdminConnection } = require('./db-admin.cjs');

const ACCOUNT = '896884286429';
const INSTANCE = 'faith-hub';
const GROUP = 'faith-hub-mysql84-foundations';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function aws(operation, input, service = 'rds') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-rds-'));
  const file = path.join(dir, 'request.json');
  try {
    if (input) fs.writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
    return JSON.parse(execFileSync('aws', [service, operation, '--region', 'us-east-1', '--output', 'json', ...(input ? ['--cli-input-json', 'file://' + file] : [])], {
      encoding: 'utf8', env: { ...process.env, AWS_PAGER: '' }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 12 * 1024 * 1024
    }));
  } catch (e) {
    const code = String(e.stderr || '').match(/An error occurred \(([^)]+)\)/)?.[1] || 'AWS_ERROR';
    const error = new Error(service + ':' + operation + ':' + code); error.code = code; throw error;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function ensure(ok, message) { if (!ok) throw new Error(message); }
async function mysqlState() {
  const db = await createAdminConnection();
  try {
    const [settings] = await db.query('SELECT DATABASE() AS db,@@log_bin AS binlog,@@log_bin_trust_function_creators AS trust_creators,@@binlog_format AS binlog_format');
    const [status] = await db.query("SHOW GLOBAL STATUS LIKE 'Uptime'");
    return { ...settings[0], uptime: Number(status[0].Value) };
  } finally { await db.end(); }
}
async function main() {
  require('dotenv').config({ quiet: true });
  const argv = process.argv.slice(2);
  ensure(argv.length === 3 && argv[0] === '--output' && ['--plan', '--apply'].includes(argv[2]), 'Uso: node scripts/prepare-foundations-rds.cjs --output evidencia-nova.json --plan|--apply');
  ensure(!fs.existsSync(argv[1]), 'Não sobrescrever evidência anterior.');
  const actor = aws('get-caller-identity', null, 'sts');
  ensure(actor.Account === ACCOUNT, 'WRONG_AWS_ACCOUNT');
  const readInstance = () => aws('describe-db-instances', { DBInstanceIdentifier: INSTANCE }).DBInstances[0];
  let instance = readInstance();
  ensure(instance.Engine === 'mysql' && instance.EngineVersion.startsWith('8.4') && instance.DBInstanceStatus === 'available', 'UNEXPECTED_RDS_TARGET');
  ensure(instance.Endpoint.Address === process.env.DB_HOST, 'RDS_HOST_MISMATCH');
  ensure(Object.keys(instance.PendingModifiedValues || {}).length === 0, 'UNRELATED_RDS_CHANGES_PENDING');
  const previousGroup = instance.DBParameterGroups[0].DBParameterGroupName;
  ensure(['default.mysql8.4', GROUP].includes(previousGroup), 'REVIEW_CUSTOM_SOURCE_GROUP_FIRST');
  const before = await mysqlState();
  ensure(before.db === 'faith-hub' && before.binlog_format === 'ROW', 'MYSQL_TARGET_OR_BINLOG_MISMATCH');
  const report = { startedAt: new Date().toISOString(), actor: actor.Arn, instance: INSTANCE, previousGroup, targetGroup: GROUP, before,
    mode: argv[2], snapshot: 'faith-hub-pre-foundations-20261113', steps: [], rebootRequested: false };
  const save = () => fs.writeFileSync(argv[1], JSON.stringify(report, null, 2) + '\n');
  save();
  if (argv[2] === '--plan') { console.log(JSON.stringify(report, null, 2)); return; }
  try {
    let snapshot;
    try { snapshot = aws('describe-db-snapshots', { DBSnapshotIdentifier: report.snapshot }).DBSnapshots[0]; }
    catch (e) { if (!['DBSnapshotNotFound', 'DBSnapshotNotFoundFault'].includes(e.code)) throw e; }
    if (!snapshot) {
      snapshot = aws('create-db-snapshot', { DBInstanceIdentifier: INSTANCE, DBSnapshotIdentifier: report.snapshot, Tags: [{ Key: 'Release', Value: 'intelligence-foundations-20261113' }] }).DBSnapshot;
      report.steps.push('SNAPSHOT_REQUESTED'); save();
    }
    ensure(snapshot.DBInstanceIdentifier === INSTANCE && snapshot.Engine === 'mysql', 'SNAPSHOT_TARGET_MISMATCH');
    for (let attempt = 0; snapshot.Status !== 'available' && attempt < 180; attempt++) {
      await wait(5000); snapshot = aws('describe-db-snapshots', { DBSnapshotIdentifier: report.snapshot }).DBSnapshots[0];
    }
    ensure(snapshot.Status === 'available', 'SNAPSHOT_NOT_READY');
    report.steps.push('SNAPSHOT_AVAILABLE'); save();

    let group;
    try { group = aws('describe-db-parameter-groups', { DBParameterGroupName: GROUP }).DBParameterGroups[0]; }
    catch (e) { if (!['DBParameterGroupNotFound', 'DBParameterGroupNotFoundFault'].includes(e.code)) throw e; }
    if (!group) group = aws('create-db-parameter-group', { DBParameterGroupName: GROUP, DBParameterGroupFamily: 'mysql8.4', Description: 'Faith Hubs foundations: reviewed dynamic trigger prerequisite', Tags: [{ Key: 'Release', Value: 'intelligence-foundations-20261113' }] }).DBParameterGroup;
    ensure(group.DBParameterGroupFamily === 'mysql8.4', 'PARAMETER_FAMILY_MISMATCH');
    const all = aws('describe-db-instances', {}).DBInstances;
    ensure(!all.some(d => d.DBInstanceIdentifier !== INSTANCE && d.DBParameterGroups.some(p => p.DBParameterGroupName === GROUP)), 'GROUP_SHARED_WITH_OTHER_DATABASE');
    const original = aws('describe-db-parameters', { DBParameterGroupName: 'default.mysql8.4' }).Parameters;
    const target = aws('describe-db-parameters', { DBParameterGroupName: GROUP }).Parameters;
    const originalMap = new Map(original.map(p => [p.ParameterName, p.ParameterValue ?? null]));
    const differences = target.filter(p => p.ParameterName !== 'log_bin_trust_function_creators' && (p.ParameterValue ?? null) !== originalMap.get(p.ParameterName));
    ensure(!differences.length && target.length === original.length, 'PARAMETER_GROUP_HAS_UNRELATED_DIFFERENCES');
    const trust = target.find(p => p.ParameterName === 'log_bin_trust_function_creators');
    ensure(trust?.ApplyType === 'dynamic' && trust.IsModifiable, 'PREREQUISITE_IS_NOT_DYNAMIC');
    report.unrelatedParameterDifferences = 0;
    if (previousGroup !== GROUP) {
      ensure((trust.ParameterValue ?? '0') === '0', 'NEW_GROUP_MUST_BE_ASSOCIATED_UNCHANGED_FIRST');
      instance = readInstance(); ensure(!Object.keys(instance.PendingModifiedValues || {}).length, 'UNRELATED_RDS_CHANGES_PENDING');
      aws('modify-db-instance', { DBInstanceIdentifier: INSTANCE, DBParameterGroupName: GROUP, ApplyImmediately: false });
      report.steps.push('UNCHANGED_GROUP_ASSOCIATED'); save();
      for (let attempt = 0; attempt < 30; attempt++) {
        instance = readInstance();
        if (instance.DBParameterGroups.some(p => p.DBParameterGroupName === GROUP)) break;
        await wait(5000);
      }
      ensure(instance.DBParameterGroups.some(p => p.DBParameterGroupName === GROUP), 'GROUP_NOT_ASSOCIATED');
    }
    // AWS documents immediate application for dynamic parameters modified AFTER association.
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        aws('modify-db-parameter-group', { DBParameterGroupName: GROUP, Parameters: [{ ParameterName: 'log_bin_trust_function_creators', ParameterValue: '1', ApplyMethod: 'immediate' }] });
        break;
      } catch (e) {
        if (e.code !== 'InvalidDBParameterGroupState' || attempt === 59) throw e;
        // Association is eventually consistent; retry only this temporary RDS state.
        await wait(5000);
      }
    }
    report.steps.push('DYNAMIC_PARAMETER_SET'); save();
    let after;
    for (let attempt = 0; attempt < 30; attempt++) {
      after = await mysqlState();
      if (Number(after.trust_creators) === 1) break;
      await wait(5000);
    }
    ensure(Number(after.trust_creators) === 1 && after.binlog_format === 'ROW', 'PARAMETER_NOT_EFFECTIVE_NO_REBOOT_ATTEMPTED');
    ensure(after.uptime >= before.uptime, 'UNEXPECTED_DATABASE_UPTIME_RESET');
    report.after = after; report.parameterGroups = readInstance().DBParameterGroups; report.status = 'VERIFIED_WITHOUT_REBOOT'; save();
    console.log(JSON.stringify(report, null, 2));
  } catch (e) { report.status = 'STOPPED'; report.error = e.message; save(); throw e; }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
