const { test } = require('node:test'), assert = require('node:assert/strict'), ts = require('typescript'), fs = require('fs');
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f);
let calls = [], owned = [], actor = { userId: 'admin', organizationId: 'org-a', role: 'ADMIN', campusIds: ['all'] }, audits = [];
const response = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
function mock(file, exports) { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; }
mock('../src/db/index.ts', { apiResponse: response, query: async (sql, params = []) => { assert.equal((sql.match(/\?/g) || []).length, params.length); calls.push({ sql, params }); return { rows: sql.includes('SELECT id, address') ? owned : [] }; } });
mock('../src/services/authMiddleware.ts', { requireAuth: async () => actor ? { user: actor } : { errorResponse: response(401, {}) }, getAuthenticatedUser: async () => actor, enforceRole: (user, roles) => roles.includes(user.role) ? { allowed: true } : { allowed: false, errorResponse: response(403, {}) }, enforceTenant: (user, org) => org && org !== user.organizationId ? { allowed: false, errorResponse: response(403, {}) } : { allowed: true, effectiveOrgId: user.organizationId } });
mock('../src/services/planAccess.ts', { enforcePlanAccess: async () => null });
mock('../src/services/auditLogService.ts', { logSecurityEvent: async entry => audits.push(entry) });
const { createOrUpdateCampus, listCampuses } = require('../src/functions/campuses.ts');
const event = patch => ({ body: JSON.stringify({ id: 'unit-a', organization_id: 'org-a', name: 'Unidade A', slug: 'a', address: 'Rua A', ...patch }), headers: {}, queryStringParameters: {} });
function reset() { calls = []; audits = []; owned = [{ id: 'unit-a', address: 'Rua A', latitude: '-27', longitude: '-48' }]; actor = { userId: 'admin', organizationId: 'org-a', role: 'ADMIN', campusIds: ['all'] }; }
test('persist coordinates within the authenticated tenant and audit the change', async () => {
  reset(); const result = await createOrUpdateCampus(event({ latitude: -26.5, longitude: -49.1 })); assert.equal(result.statusCode, 200);
  const insert = calls.find(c => c.sql.includes('UPDATE campuses SET\n        name')); assert.deepEqual(insert.params.slice(-4, -2), [-26.5, -49.1]); assert.equal(insert.params.at(-2), 'org-a'); assert.equal(insert.params.at(-1), 'unit-a');
  assert.match(calls[0].sql, /organization_id = \?/); assert.equal(audits[0].details.latitude, -26.5);
});
test('reject invalid/incomplete coordinates before writing', async () => {
  for (const point of [{ latitude: 91, longitude: 0 }, { latitude: 1 }, { latitude: null, longitude: 1 }]) { reset(); assert.equal((await createOrUpdateCampus(event(point))).statusCode, 400); assert(!calls.some(c => /INSERT INTO|UPDATE campuses/.test(c.sql))); }
});
test('preserve a pin for unrelated edits, invalidate it when address changes, and support explicit removal', async () => {
  for (const [patch, expected] of [[{}, [-27, -48]], [{ address: 'Outra rua' }, [null, null]], [{ latitude: '', longitude: '' }, [null, null]]]) {
    reset(); assert.equal((await createOrUpdateCampus(event(patch))).statusCode, 200); assert.deepEqual(calls.find(c => c.sql.includes('UPDATE campuses SET\n        name')).params.slice(-4, -2), expected);
  }
});
test('foreign tenant/unit, unauthenticated and unauthorized roles cannot change campus locations', async () => {
  reset(); assert.equal((await createOrUpdateCampus(event({ organization_id: 'org-b' }))).statusCode, 403); assert.equal(calls.length, 0);
  reset(); owned = []; assert.equal((await createOrUpdateCampus(event({}))).statusCode, 404); assert(!calls.some(c => /INSERT INTO|UPDATE campuses/.test(c.sql)));
  reset(); actor = null; assert.equal((await createOrUpdateCampus(event({}))).statusCode, 401); assert.equal(calls.length, 0);
  reset(); actor.role = 'MEMBER'; assert.equal((await createOrUpdateCampus(event({}))).statusCode, 403); assert.equal(calls.length, 0);
});
test('public directory scopes tenant and its aggregate joins', async () => {
  reset(); actor = null; await listCampuses({ queryStringParameters: { organization_id: 'org-public' } });
  assert.equal(calls[0].params[0], 'org-public'); assert.match(calls[0].sql, /m.organization_id = c.organization_id/); assert.match(calls[0].sql, /cg.organization_id = c.organization_id/);
});
