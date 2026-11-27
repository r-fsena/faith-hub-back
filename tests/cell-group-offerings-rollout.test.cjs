const { test } = require('node:test');
const assert = require('node:assert/strict');
const { disableOfferings } = require('../scripts/disable-cell-group-offerings.cjs');
function fixture(failAudit = false) {
  const rows = [
    { id: 'global', organization_id: 'global', campus_id: null, environment: 'all', is_enabled: 0 },
    { id: 'tenant', organization_id: 'org-a', campus_id: null, environment: 'production', is_enabled: 1 },
    { id: 'campus', organization_id: 'org-a', campus_id: 'campus-a', environment: 'staging', is_enabled: 1 },
    { id: 'development', organization_id: 'org-a', campus_id: null, environment: 'development', is_enabled: 1 },
    { id: 'already-off', organization_id: 'org-b', campus_id: null, environment: 'all', is_enabled: 0 }
  ];
  const calls = [], transactions = []; let original;
  const db = {
    beginTransaction: async () => { transactions.push('begin'); original = structuredClone(rows); },
    commit: async () => transactions.push('commit'),
    rollback: async () => { transactions.push('rollback'); rows.splice(0, rows.length, ...original); },
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM organizations')) return [[{ id: 'org-a' }, { id: 'org-b' }]];
      if (sql.includes('FROM tenant_feature_flags')) return [structuredClone(rows.filter(r => r.organization_id === params[0]))];
      if (sql.startsWith('UPDATE tenant_feature_flags')) {
        assert.match(sql, /WHERE organization_id = \? AND id = \? AND feature_key = \?/);
        const row = rows.find(r => r.organization_id === params[1] && r.id === params[2]);
        assert.equal(params[3], 'cell_groups.offerings'); row.is_enabled = 0; return [{ affectedRows: 1 }];
      }
      if (sql.includes('INSERT INTO security_audit_logs')) { if (failAudit) throw Error('AUDIT_UNAVAILABLE'); return [{ affectedRows: 1 }]; }
      throw Error('Unexpected SQL');
    }
  };
  return { db, rows, calls, transactions };
}
test('plan enumerates all environments without writing or starting a transaction', async () => {
  const f = fixture(); const result = await disableOfferings(f.db, { releaseId: 'FH-OFFERINGS-TEST' });
  assert.equal(result.enabled, 3); assert.equal(result.organizations, 2); assert.deepEqual(f.transactions, []);
  assert.ok(f.calls.every(c => c.sql.startsWith('SELECT')));
});
test('rollout preserves prior values before disabling only enabled offer flags in every scope', async () => {
  const f = fixture(); let backup;
  const result = await disableOfferings(f.db, { releaseId: 'FH-OFFERINGS-TEST', apply: true, saveBefore: async value => { backup = value; assert.equal(f.rows.filter(r => r.is_enabled).length, 3); } });
  assert.equal(result.disabled, 3); assert.equal(result.enabled, 0);
  assert.equal(backup.flags.filter(r => r.is_enabled).length, 3);
  assert.ok(f.rows.every(r => !r.is_enabled));
  assert.equal(f.calls.filter(c => c.sql.includes('INSERT INTO security_audit_logs')).length, 3);
  assert.deepEqual(f.transactions, ['begin', 'commit']);
});
test('audit failure or backup failure rolls the entire operation back', async () => {
  for (const failure of ['audit', 'backup']) {
    const f = fixture(failure === 'audit');
    await assert.rejects(disableOfferings(f.db, { releaseId: 'FH-OFFERINGS-TEST', apply: true, saveBefore: async () => { if (failure === 'backup') throw Error('BACKUP_FAILED'); } }));
    assert.equal(f.rows.filter(r => r.is_enabled).length, 3);
    assert.deepEqual(f.transactions, ['begin', 'rollback']);
  }
});
