/** Explicit maintenance command: only public unit locations, never user GPS. */
require('dotenv').config({ quiet: true });
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const { createAdminConnection } = require('./db-admin.cjs');
const data = require('./data/campus-coordinate-sources-palavra-viva-20261109.json');
const { migrate } = require('./migrate-campus-coordinates.cjs');
require.extensions['.ts'] = (m, filename) => m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { logSecurityEvent } = require('../src/services/auditLogService.ts');

async function run() {
  const apply = process.argv.includes('--apply'), actorEmail = process.argv.find(a => a.startsWith('--actor-email='))?.slice(14);
  const db = await createAdminConnection();
  try {
    if (!apply) { console.log(JSON.stringify({ organizationId: data.organization_id, ready: data.entries.filter(e => e.status === 'READY').length, pending: data.entries.filter(e => e.status !== 'READY').map(e => ({ name: e.name, reason: e.reason })) })); return; }
    const [actors] = await db.query("SELECT id, email, role FROM members WHERE organization_id = ? AND LOWER(email) = LOWER(?) AND role = 'SUPERADMIN' LIMIT 1", ['org_default', actorEmail || '']);
    if (actors.length !== 1) throw Error('AUTHORIZED_MASTER_ACTOR_REQUIRED');
    await migrate(db);
    await db.beginTransaction();
    try {
      const [units] = await db.query('SELECT id,address,latitude,longitude FROM campuses WHERE organization_id = ? FOR UPDATE', [data.organization_id]);
      const changes = [];
      for (const entry of data.entries.filter(e => e.status === 'READY')) {
        const unit = units.find(c => c.id === entry.campus_id);
        if (!unit || unit.address !== entry.expected_address) throw Error('UNIT_ADDRESS_CHANGED: ' + entry.name);
        if (unit.latitude !== null || unit.longitude !== null) {
          if (Number(unit.latitude) !== entry.latitude || Number(unit.longitude) !== entry.longitude) throw Error('UNIT_PIN_ALREADY_CONFIGURED: ' + entry.name);
          continue;
        }
        await db.query('UPDATE campuses SET latitude = ?, longitude = ? WHERE organization_id = ? AND id = ?', [entry.latitude, entry.longitude, data.organization_id, entry.campus_id]);
        const actor = actors[0];
        await logSecurityEvent({ organizationId: data.organization_id, campusId: entry.campus_id, user: { userId: actor.id, email: actor.email, role: actor.role, isSuperAdmin: true, organizationId: 'org_default', campusIds: ['all'], operationalPermissions: [] }, action: 'CONFIGURE_CAMPUS_LOCATION', resource: 'campuses', resourceId: entry.campus_id, details: { sourceUrl: entry.source_url, coordinateSource: entry.coordinate_source, latitude: entry.latitude, longitude: entry.longitude, previous: { latitude: unit.latitude, longitude: unit.longitude }, reason: 'Ordenação das unidades por proximidade no PWA' }, strict: true, executor: (sql, params) => db.query(sql, params) });
        changes.push(entry.campus_id);
      }
      await db.commit();
      console.log(JSON.stringify({ organizationId: data.organization_id, updated: changes.length, coordinatesReady: data.entries.filter(e => e.status === 'READY').length, pending: data.entries.filter(e => e.status !== 'READY').map(e => e.name), memberDataModified: false }));
    } catch (e) { await db.rollback(); throw e; }
  } finally { await db.end(); }
}
if (require.main === module) run().catch(e => { console.error(e.code || e.message); process.exitCode = 1; });
