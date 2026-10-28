const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '..');
const DomainConsolidation = require('../infrastructure/serverless-domain-consolidation.cjs');

test('domain consolidation preserves every event while reducing action lambdas', () => {
  const functions = { ungroupedHandler: { handler: 'ungrouped.handler', events: [] } };
  let expectedEventCount = 0;

  for (const group of Object.values(DomainConsolidation.domainGroups)) {
    for (const source of group.sources) {
      functions[source] = {
        handler: `${source}.handler`,
        events: [{ httpApi: { method: 'GET', path: `/test/${source}` } }]
      };
      expectedEventCount += 1;
    }
  }
  functions.pdvInventory.timeout = 60;

  const serverless = {
    service: {
      service: 'faith-hub-backend',
      provider: { stage: 'dev' },
      functions
    }
  };
  const plugin = new DomainConsolidation(serverless);
  plugin.consolidate();

  const aggregateNames = Object.keys(DomainConsolidation.domainGroups);
  assert.deepEqual(Object.keys(functions).sort(), ['ungroupedHandler', ...aggregateNames].sort());
  assert.equal(
    aggregateNames.reduce((total, name) => total + functions[name].events.length, 0),
    expectedEventCount
  );
  assert.equal(functions.pdvInventory.timeout, 60);
  for (const [name, group] of Object.entries(DomainConsolidation.domainGroups)) {
    assert.equal(functions[name].handler, group.handler);
    assert.equal(functions[name].name, `faith-hub-backend-dev-${name}`);
  }
});

test('legacy log groups are retained during the two-phase stack cutover', () => {
  const template = {
    Resources: {
      LegacyLogGroup: { Type: 'AWS::Logs::LogGroup', Properties: {} },
      Lambda: { Type: 'AWS::Lambda::Function', Properties: {} }
    }
  };
  const plugin = new DomainConsolidation({
    service: { provider: { compiledCloudFormationTemplate: template } }
  });
  plugin.retainLogGroups();
  assert.equal(template.Resources.LegacyLogGroup.DeletionPolicy, 'Retain');
  assert.equal(template.Resources.LegacyLogGroup.UpdateReplacePolicy, 'Retain');
  assert.equal(template.Resources.Lambda.DeletionPolicy, undefined);
});

test('aggregate handlers are assigned to independent nested stacks without force migration', () => {
  const stackMap = require('../stacks-map.js');
  const expectations = {
    MembersApiLambdaFunction: 'ApiMembers',
    HttpApiIntegrationContentApi: 'ApiContent',
    CommunityApiLogGroup: 'ApiCommunity',
    TenantApiLambdaPermissionHttpApi: 'ApiTenant',
    SaasApiLambdaFunction: 'ApiSaas'
  };
  for (const [logicalId, destination] of Object.entries(expectations)) {
    assert.deepEqual(stackMap({}, logicalId), { destination });
  }
  const source = fs.readFileSync(path.join(backendRoot, 'stacks-map.js'), 'utf8');
  assert.doesNotMatch(source, /force:\s*true/);
});

test('domain route maps do not contain duplicate route keys', () => {
  const files = ['membersApi.ts', 'pdvApi.ts', 'contentApi.ts', 'communityApi.ts', 'tenantApi.ts', 'saasApi.ts'];
  for (const file of files) {
    const source = fs.readFileSync(path.join(backendRoot, 'src/functions', file), 'utf8');
    const routeKeys = [...source.matchAll(/^\s+'([^']+)':/gm)].map((match) => match[1]);
    assert.ok(routeKeys.length > 0, `${file} precisa declarar rotas`);
    assert.equal(new Set(routeKeys).size, routeKeys.length, `${file} contém rota duplicada`);
  }
});
