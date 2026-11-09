const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), path = require('node:path');
const target = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/services/campusCoordinates.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module: target, exports: target.exports });
const { parseCampusCoordinates } = target.exports;
test('coordinates require both values, valid ranges, and accept zero', () => {
  assert.equal(parseCampusCoordinates('0', '0').latitude, 0);
  assert.equal(parseCampusCoordinates(null, '').longitude, null);
  for (const [lat, lng] of [[1, null], [null, 1], [91, 1], [1, -181], [true, false], ['Infinity', 0], ['abc', 0]]) assert.throws(() => parseCampusCoordinates(lat, lng));
});
test('migration is additive and repeatable', async () => {
  const { migrate } = require('../scripts/migrate-campus-coordinates.cjs');
  const cols = [], statements = [];
  const db = { query: async sql => { statements.push(sql); if (sql.startsWith('SELECT')) return [cols.map(COLUMN_NAME => ({ COLUMN_NAME }))]; cols.push(sql.match(/ADD COLUMN (\w+)/)[1]); return []; } };
  await migrate(db); await migrate(db);
  assert.deepEqual(cols, ['latitude', 'longitude']); assert.equal(statements.filter(s => s.startsWith('ALTER')).length, 2);
});
