process.env.AWS_EC2_METADATA_DISABLED = 'true';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, filename);
const mock = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const response = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
let state;
const cell = { id: 'group-a', organization_id: 'org-a', campus_id: 'campus-a', leader_id: 'leader-a', name: 'Grupo A' };
const flag = (enabled, org = 'org-a', environment = 'production', campus = null) => ({
  organization_id: org, environment, campus_id: campus, feature_key: 'cell_groups.offerings', is_enabled: Number(enabled)
});
mock('../src/db/index.ts', {
  apiResponse: response,
  query: async (sql, params = []) => {
    assert.equal((sql.match(/\?/g) || []).length, params.length, sql);
    state.queries.push({ sql, params });
    if (sql.includes('FROM organizations')) return { rows: [state.organization] };
    if (sql.includes('FROM tenant_feature_flags')) return { rows: state.flags.filter(row =>
      ['global', params[0]].includes(row.organization_id) && ['all', params[1]].includes(row.environment) &&
      (!row.campus_id || row.campus_id === params[2])) };
    if (sql.includes('FROM cell_groups')) {
      assert.match(sql, /organization_id = \?/);
      return { rows: params[0] === cell.id && params[1] === cell.organization_id ? [cell] : [] };
    }
    if (sql.includes('FROM cell_meetings')) return { rows: [{ id: 'meeting-a', meeting_date: '2026-11-27', offerings_amount: '85.50' }] };
    if (sql.includes('FROM cell_meeting_attendees')) return { rows: [] };
    if (sql.includes('FROM members')) return { rows: state.members };
    throw Error('Unexpected query: ' + sql);
  },
  getConnection: async () => {
    state.connections++;
    return {
      beginTransaction: async () => state.transactions.push('begin'),
      commit: async () => state.transactions.push('commit'),
      rollback: async () => state.transactions.push('rollback'),
      release: () => state.transactions.push('release'),
      query: async (sql, params = []) => {
        assert.equal((sql.match(/\?/g) || []).length, params.length, sql);
        if (state.failAudit && sql.includes('INSERT INTO security_audit_logs')) throw Error('AUDIT_UNAVAILABLE');
        state.writes.push({ sql, params });
        return [{ affectedRows: 1 }];
      }
    };
  }
});
mock('../src/services/memberHistoryWrite.ts', {});
const auth = require('../src/services/authMiddleware.ts');
auth.requireAuth = async () => state.user ? { user: state.user } : { errorResponse: response(401, {}) };
const flags = require('../src/services/featureFlagService.ts');
const handlers = require('../src/functions/cellGroups.ts');
const flagsApi = require('../src/functions/featureFlags.ts');
const { buildPlanContract } = require('../src/services/planCatalog.ts');
const planCatalog = require('../src/config/commercialPlans.json');
const request = (body = {}, extra = {}) => ({
  body: JSON.stringify({ meeting_date: '2026-11-27', ...body }),
  headers: { 'x-organization-id': 'org-a' }, pathParameters: { id: 'group-a', meetingId: 'meeting-a' }, queryStringParameters: {}, ...extra
});
beforeEach(() => {
  delete process.env.APP_STAGE;
  state = { user: { userId: 'leader-a', organizationId: 'org-a', role: 'LEADER', campusIds: ['campus-a'], isSuperAdmin: false },
    organization: { id: 'org-a', plan: 'PRO' }, flags: [], queries: [], writes: [], transactions: [], connections: 0, members: [] };
});

test('offerings starts disabled and appears in the management catalog without database seeding', async () => {
  const evaluated = await flags.evaluateTenantFlags('org-a');
  assert.equal(evaluated.flags['cell_groups.offerings'], false);
  assert.equal(evaluated.catalog.find(item => item.key === 'cell_groups.offerings').category, 'Pequenos grupos');
});

test('existing commercial contracts allow this optional switch only within the included cell-group module', async () => {
  const plan = structuredClone(planCatalog.plans[0]);
  state.organization = { id: 'org-a', plan: plan.id, plan_contract: buildPlanContract(plan) };
  assert.equal((await flags.evaluateTenantFlags('org-a')).flags['cell_groups.offerings'], false);
  state.flags = [flag(true)];
  let evaluated = await flags.evaluateTenantFlags('org-a');
  assert.equal(evaluated.flags['cell_groups.offerings'], true);
  assert.equal(evaluated.catalog.find(item => item.key === 'cell_groups.offerings').contracted, true);
  state.flags.push({ organization_id: 'org-a', feature_key: 'cell_groups.module_enabled', is_enabled: 0, environment: 'all' });
  assert.equal((await flags.evaluateTenantFlags('org-a')).flags['cell_groups.offerings'], false);
  state.flags.pop();
  state.organization.trial_expires_at = '2020-01-01';
  assert.equal((await flags.evaluateTenantFlags('org-a')).flags['cell_groups.offerings'], false);
});

test('tenant-wide release applies across groups/campuses while another environment or tenant stays disabled', async () => {
  state.flags = [flag(true)];
  assert.equal((await flags.evaluateTenantFlags('org-a', 'campus-a')).flags['cell_groups.offerings'], true);
  assert.equal((await flags.evaluateTenantFlags('org-a', 'campus-b')).flags['cell_groups.offerings'], true);
  assert.equal((await flags.evaluateTenantFlags('org-a', 'campus-a', 'staging')).flags['cell_groups.offerings'], false);
  state.flags = [flag(true, 'org-b')];
  assert.equal((await flags.evaluateTenantFlags('org-a')).flags['cell_groups.offerings'], false);
});

test('disabled flag blocks direct nonzero offers before any transaction; attendance with omitted or zero offer works', async () => {
  assert.equal((await handlers.recordMeeting(request({ offerings_amount: 85.5 }))).statusCode, 403);
  assert.equal(state.connections, 0);
  for (const body of [{}, { offerings_amount: 0 }]) assert.equal((await handlers.recordMeeting(request(body))).statusCode, 201);
  assert.deepEqual(state.writes.filter(w => w.sql.includes('INSERT INTO cell_meetings')).map(w => w.params[7]), [0, 0]);
});

test('enabled offer persists the amount and financial audit atomically', async () => {
  state.flags = [flag(true)];
  assert.equal((await handlers.recordMeeting(request({ offerings_amount: 85.5 }))).statusCode, 201);
  assert.equal(state.writes.find(w => w.sql.includes('INSERT INTO cell_meetings')).params[7], 85.5);
  const audit = state.writes.find(w => w.sql.includes('INSERT INTO security_audit_logs'));
  assert.equal(audit.params[1], 'org-a');
  assert.equal(JSON.parse(audit.params[9]).offerings_amount, 85.5);
  assert.deepEqual(state.transactions, ['begin', 'commit', 'release']);
  state.transactions = []; state.failAudit = true;
  assert.equal((await handlers.recordMeeting(request({ offerings_amount: 20 }))).statusCode, 500);
  assert.deepEqual(state.transactions, ['begin', 'rollback', 'release']);
});

test('authentication, role, tenant, campus and group leadership deny unauthorized writes', async () => {
  state.user = null;
  assert.equal((await handlers.recordMeeting(request())).statusCode, 401);
  state.user = { userId: 'leader-a', organizationId: 'org-a', role: 'MEMBER', campusIds: ['campus-a'], isSuperAdmin: false };
  assert.equal((await handlers.recordMeeting(request())).statusCode, 403);
  state.user.role = 'LEADER';
  assert.equal((await handlers.recordMeeting(request({}, { headers: { 'x-organization-id': 'org-b' } }))).statusCode, 403);
  state.user.campusIds = ['campus-b'];
  assert.equal((await handlers.recordMeeting(request())).statusCode, 403);
  state.user.campusIds = ['campus-a']; state.user.userId = 'other-leader';
  assert.equal((await handlers.recordMeeting(request())).statusCode, 403);
  assert.equal(state.connections, 0);
});

test('client environment and campus cannot select an unrelated enabled override', async () => {
  state.flags = [flag(true, 'org-a', 'staging'), flag(true, 'org-a', 'production', 'campus-b')];
  assert.equal((await handlers.recordMeeting(request({ offerings_amount: 50 }, {
    headers: { 'x-organization-id': 'org-a', 'x-environment': 'staging', 'x-campus-id': 'campus-b' }, queryStringParameters: { env: 'staging' }
  }))).statusCode, 403);
  state.flags = [flag(true)]; process.env.APP_STAGE = 'dev';
  assert.equal((await handlers.recordMeeting(request({ offerings_amount: 50 }))).statusCode, 201);
  process.env.APP_STAGE = 'staging';
  assert.equal((await handlers.recordMeeting(request({ offerings_amount: 50 }))).statusCode, 403);
});

test('invalid amounts and attendee references cannot create a meeting', async () => {
  state.flags = [flag(true)];
  for (const offerings_amount of [-1, 'abc', null, true, {}, 'Infinity']) {
    assert.equal((await handlers.recordMeeting(request({ offerings_amount }))).statusCode, 400);
  }
  assert.equal((await handlers.recordMeeting(request({ attendees: [{ member_id: 'foreign-member' }] }))).statusCode, 400);
  assert.equal(state.connections, 0);
});

test('scoped attendance retains member and visitor counts when saving an offer', async () => {
  state.flags = [flag(true)]; state.members = [{ id: 'member-a' }];
  const result = await handlers.recordMeeting(request({ offerings_amount: 12.5, attendees: [
    { member_id: 'member-a', status: 'PRESENT' }, { visitor_name: 'Visitante', status: 'PRESENT' }
  ] }));
  assert.equal(result.statusCode, 201);
  assert.deepEqual([JSON.parse(result.body).present_count, JSON.parse(result.body).visitor_count], [2, 1]);
  assert.equal(state.writes.filter(w => w.sql.includes('INSERT INTO cell_meeting_attendees')).length, 2);
  const lookup = state.queries.find(q => q.sql.includes('FROM members'));
  assert.deepEqual(lookup.params, ['org-a', 'group-a', 'campus-a', 'member-a']);
});

test('history and detail hide historical offerings when disabled and restore visibility when enabled', async () => {
  for (const enabled of [false, true, false]) {
    state.flags = [flag(enabled)];
    const history = JSON.parse((await handlers.getCellMeetings(request())).body);
    const detail = JSON.parse((await handlers.getCellMeetingDetails(request())).body);
    assert.equal('offerings_amount' in history[0], enabled);
    assert.equal('offerings_amount' in detail, enabled);
    assert.equal(detail.id, 'meeting-a');
  }
  assert.equal(state.writes.length, 0);
});

test('leaders cannot release offerings; authorized tenant administrators can release existing commercial tenants', async () => {
  const body = { feature_key: 'cell_groups.offerings', is_enabled: true, organization_id: 'org-a' };
  assert.equal((await flagsApi.toggleFeatureFlag(request(body))).statusCode, 403);
  state.user.role = 'ADMIN';
  // Reuse the isolated database with write support for the management endpoint.
  const db = require('../src/db/index.ts'), original = db.query;
  db.query = async (sql, params) => {
    if (/^\s*INSERT/.test(sql)) { state.writes.push({ sql, params }); return { rows: [] }; }
    return original(sql, params);
  };
  try {
    const plan = structuredClone(planCatalog.plans[0]);
    state.organization = { id: 'org-a', plan: plan.id, plan_contract: buildPlanContract(plan) };
    assert.equal((await flagsApi.toggleFeatureFlag(request(body))).statusCode, 200);
    const write = state.writes.find(w => w.sql.includes('INSERT INTO tenant_feature_flags'));
    assert.deepEqual([write.params[1], write.params[2], write.params[3], write.params[4]], ['org-a', null, 'all', 'cell_groups.offerings']);
    assert.ok(state.writes.some(w => w.sql.includes('INSERT INTO security_audit_logs')));
  } finally { db.query = original; }
});

test('catalog migration is read-only in status mode and preserves an existing global setting', async () => {
  const { applyMigration } = require('../migrate_cell_group_offerings.js');
  const calls = [], transactions = [];
  const db = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.includes('FROM tenant_feature_flags')) return [[{ id: 'existing-enabled' }]];
      return [[]];
    }, beginTransaction: async () => transactions.push('begin'), commit: async () => transactions.push('commit'), rollback: async () => transactions.push('rollback')
  };
  await applyMigration(db, { statusOnly: true });
  assert.equal(calls.length, 1); assert.equal(transactions.length, 0);
  const result = await applyMigration(db);
  assert.equal(result.inserted, false);
  assert.ok(!calls.some(c => /INSERT INTO tenant_feature_flags|UPDATE tenant_feature_flags|DELETE FROM tenant_feature_flags/.test(c.sql)));
  assert.deepEqual(transactions, ['begin', 'commit']);
});

test('catalog migration inserts a disabled default once and rolls back on audit failure', async () => {
  const { applyMigration } = require('../migrate_cell_group_offerings.js');
  let appliedChecksum, failAudit = false;
  const writes = [], transactions = [];
  const db = {
    query: async (sql, params = []) => {
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.includes('FROM schema_migrations')) return [appliedChecksum ? [{ checksum: appliedChecksum }] : []];
      if (/^\s*INSERT/.test(sql)) {
        if (failAudit && sql.includes('security_audit_logs')) throw Error('AUDIT_UNAVAILABLE');
        writes.push({ sql, params });
        if (sql.includes('INSERT INTO schema_migrations')) appliedChecksum = params[1];
      }
      return [[]];
    }, beginTransaction: async () => transactions.push('begin'), commit: async () => transactions.push('commit'), rollback: async () => transactions.push('rollback')
  };
  assert.equal((await applyMigration(db)).inserted, true);
  assert.equal((await applyMigration(db)).alreadyApplied, true);
  const defaults = writes.filter(w => w.sql.includes('INSERT INTO tenant_feature_flags'));
  assert.equal(defaults.length, 1);
  assert.match(defaults[0].sql, /'all',\?,0/);
  assert.deepEqual(transactions, ['begin', 'commit']);
  appliedChecksum = null; failAudit = true; transactions.length = 0;
  await assert.rejects(applyMigration(db), /AUDIT_UNAVAILABLE/);
  assert.deepEqual(transactions, ['begin', 'rollback']);
});
