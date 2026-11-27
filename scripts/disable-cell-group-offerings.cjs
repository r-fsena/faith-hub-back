const fs = require('node:fs');
const path = require('node:path');
const featureKey = 'cell_groups.offerings';

async function readFlags(db, lock = false) {
  const [organizations] = await db.query('SELECT id FROM organizations ORDER BY id');
  const ids = [...new Set(['global', ...organizations.map(row => row.id)])];
  const flags = [];
  for (const organizationId of ids) {
    const [rows] = await db.query(
      `SELECT id,organization_id,campus_id,environment,is_enabled,updated_by,updated_at FROM tenant_feature_flags WHERE organization_id = ? AND feature_key = ?${lock ? ' FOR UPDATE' : ''}`,
      [organizationId, featureKey]
    );
    flags.push(...rows);
  }
  return { organizations: ids.length - 1, flags };
}

async function disableOfferings(db, { releaseId, apply = false, saveBefore } = {}) {
  if (!/^[A-Za-z0-9._-]{6,79}$/.test(releaseId || '')) throw Error('RELEASE_ID_REQUIRED');
  if (!apply) {
    const before = await readFlags(db);
    return { featureKey, organizations: before.organizations, flags: before.flags.length, enabled: before.flags.filter(row => Number(row.is_enabled) !== 0).length, mode: 'PLAN' };
  }
  if (typeof saveBefore !== 'function') throw Error('PRIVATE_BACKUP_REQUIRED');
  await db.beginTransaction();
  try {
    const before = await readFlags(db, true);
    if (!before.flags.some(row => row.organization_id === 'global' && !row.campus_id && row.environment === 'all')) throw Error('GLOBAL_DISABLED_DEFAULT_MIGRATION_REQUIRED');
    await saveBefore({ releaseId, featureKey, capturedAt: new Date().toISOString(), ...before });
    let disabled = 0;
    for (const flag of before.flags) {
      if (Number(flag.is_enabled) === 0) continue;
      const [updated] = await db.query(
        'UPDATE tenant_feature_flags SET is_enabled = 0, updated_by = ?, updated_at = NOW() WHERE organization_id = ? AND id = ? AND feature_key = ?',
        [releaseId, flag.organization_id, flag.id, featureKey]
      );
      if (updated.affectedRows !== 1) throw Error('FLAG_CHANGED_CONCURRENTLY');
      await db.query(
        `INSERT INTO security_audit_logs(id,organization_id,campus_id,user_role,action,resource,resource_id,details,status)
         VALUES(UUID(),?,?,'SYSTEM','DISABLE_CELL_GROUP_OFFERINGS','tenant_feature_flags',?,?,'SUCCESS')`,
        [flag.organization_id, flag.campus_id || null, flag.id, JSON.stringify({ releaseId, featureKey, environment: flag.environment, before: Boolean(Number(flag.is_enabled)), after: false })]
      );
      disabled++;
    }
    const after = await readFlags(db);
    if (after.flags.some(row => Number(row.is_enabled) !== 0)) throw Error('ENABLED_OVERRIDE_REMAINS');
    await db.commit();
    return { releaseId, featureKey, organizations: after.organizations, flags: after.flags.length, disabled, enabled: 0, mode: 'APPLIED' };
  } catch (error) {
    await db.rollback();
    throw error;
  }
}

module.exports = { featureKey, disableOfferings };
if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const releaseId = args[args.indexOf('--release-id') + 1];
  const evidence = args.includes('--evidence') ? args[args.indexOf('--evidence') + 1] : '';
  if (apply && !evidence) throw Error('USE --evidence caminho-privado-novo');
  require('dotenv').config({ quiet: true });
  (async () => {
    const db = await require('./db-admin.cjs').createAdminConnection();
    try {
      const result = await disableOfferings(db, { releaseId, apply, saveBefore: async before => {
        fs.mkdirSync(path.dirname(path.resolve(evidence)), { recursive: true, mode: 0o700 });
        fs.writeFileSync(evidence, JSON.stringify(before, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      } });
      console.log(JSON.stringify(result));
    } finally { await db.end(); }
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
