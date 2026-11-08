process.env.AWS_EC2_METADATA_DISABLED = 'true';
delete process.env.USER_POOL_ID;
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true }
}).outputText, filename);
const catalog = require('../src/config/commercialPlans.json');
const { buildPlanContract, readPlanContract, applyContractEntitlements } = require('../src/services/planCatalog.ts');
const plan = id => structuredClone(catalog.plans.find(item => item.id === id));
const user = { userId: 'admin', name: 'Admin', email: 'admin@example.org', role: 'ADMIN', organizationId: 'org-a', campusIds: ['campus-a'], operationalPermissions: [], isSuperAdmin: false };
let scenario;
const response = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const dbPath = require.resolve('../src/db/index.ts');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  apiResponse: response,
  query: async (sql, params = []) => {
    assert.equal((sql.match(/\?/g) || []).length, params.length, sql);
    scenario.calls.push({ sql, params });
    if (scenario.query) return scenario.query(sql, params);
    if (sql.includes('FROM organizations')) return { rows: scenario.organization ? [scenario.organization] : [] };
    if (sql.includes('FROM tenant_feature_flags')) return { rows: scenario.flags };
    if (sql.includes('FROM saas_plans')) return { rows: scenario.plan ? [scenario.plan] : [] };
    if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) return { rows: { affectedRows: 1 } };
    throw new Error('Unexpected query: ' + sql);
  }, getConnection: async () => scenario.connection
}};
const auth = require('../src/services/authMiddleware.ts');
auth.getAuthenticatedUser = async () => scenario.user;
auth.requireAuth = async () => scenario.user ? { user: scenario.user } : { errorResponse: response(401, {}) };
for (const [file, exports] of [
  ['auditLogService', { logSecurityEvent: async value => scenario.audits.push(value) }],
  ['ministrySeedService', { seedDefaultMinistries: async (...args) => scenario.seeds.push(args) }]
]) { const p = require.resolve(`../src/services/${file}.ts`); require.cache[p] = { id: p, filename: p, loaded: true, exports }; }
const { evaluateTenantFlags } = require('../src/services/featureFlagService.ts');
const { enforcePlanAccess } = require('../src/services/planAccess.ts');
const { ProvisioningService } = require('../src/services/provisioningService.ts');
const { initializePlanEntitlements } = require('../src/services/planProvisioning.ts');
const proposals = require('../src/functions/proposals.ts');
const flagsApi = require('../src/functions/featureFlags.ts');
const organizations = require('../src/functions/organizations.ts');
const event = (body = {}, overrides = {}) => ({ body: JSON.stringify(body), headers: { 'x-organization-id': 'org-a' }, queryStringParameters: {}, pathParameters: {}, ...overrides });
const enterpriseOptions = { monthly_amount: 899, max_members: 3500, max_campuses: 10 };
function usePlan(id = 'CONECTAR') {
  const contract = buildPlanContract(plan(id), id === 'ENTERPRISE_2026' ? enterpriseOptions : {});
  scenario.organization = { id: 'org-a', plan: id, status: 'ACTIVE', plan_contract: JSON.stringify(contract) };
  return contract;
}
function transaction(proposal) {
  const state = { commits: 0, rollbacks: 0, releases: 0, writes: [] };
  scenario.connection = {
    beginTransaction: async () => {}, commit: async () => state.commits++, rollback: async () => state.rollbacks++, release: () => state.releases++,
    query: async (sql, params = []) => {
      assert.equal((sql.match(/\?/g) || []).length, params.length, sql);
      if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) { state.writes.push({ sql, params }); return [{ affectedRows: 1 }]; }
      if (sql.includes('FROM saas_proposals')) return [[proposal]];
      if (sql.includes('FROM saas_subscriptions')) return [scenario.verified ? [{ id: proposal.asaas_subscription_id }] : []];
      if (sql.includes('FROM saas_plans')) return [[scenario.plan]];
      if (sql.includes('FROM organizations')) return [sql.includes('WHERE slug') ? [] : sql.includes('FOR UPDATE') ? [scenario.organization] : []];
      if (sql.includes('FROM saas_acquisitions')) return [scenario.acquisition ? [scenario.acquisition] : []];
      if (sql.includes('FROM campuses')) return [[{ id: 'campus-trial' }]];
      if (sql.includes('FROM members')) return [scenario.owner ? [scenario.owner] : []];
      throw new Error('Unexpected transaction query: ' + sql);
    }
  }; return state;
}
beforeEach(() => { scenario = { user: { ...user }, calls: [], flags: [], audits: [], seeds: [], verified: true }; usePlan(); });

test('commercial prices, shared capacities and assisted trial match the approved matrix', () => {
  assert.deepEqual(catalog.plans.map(p => [p.name, p.monthly_price, p.max_members, p.max_campuses]), [
    ['Conectar', 99, 300, 1], ['Cuidar', 249, 700, 1], ['Gestão', 399, 1500, 5], ['Enterprise', null, null, null]
  ]);
  assert.ok(catalog.plans.every(p => p.yearly_price === null));
  assert.deepEqual([catalog.trial.plan_id, catalog.trial.max_members, catalog.trial.max_campuses, catalog.trial.duration_days, catalog.trial.card_required, catalog.trial.automatic_charge], ['CONECTAR', 300, 1, 14, false, false]);
});
test('all four tiers precisely separate common features, care and management', async () => {
  for (const id of ['CONECTAR', 'CUIDAR', 'GESTAO', 'ENTERPRISE_2026']) {
    const contract = usePlan(id); const evaluated = await evaluateTenantFlags('org-a');
    for (const key of ['members.digital_card', 'cell_groups.attendance_reports', 'studies.module_enabled', 'financial.online_pix_giving', 'financial.special_projects', 'system.saas_subscription_portal']) assert.equal(evaluated.flags[key], true, id + ':' + key);
    for (const key of ['visitors.module_enabled', 'pastoral.module_enabled', 'ministries.module_enabled', 'volunteers.module_enabled', 'kids.module_enabled']) assert.equal(evaluated.flags[key], id !== 'CONECTAR', id + ':' + key);
    for (const key of ['events.module_enabled', 'pdv.stock_inventory', 'secretariat.document_pdf', 'financial.cashflow_ledger', 'system.multicampus_enabled']) assert.equal(evaluated.flags[key], ['GESTAO', 'ENTERPRISE_2026'].includes(id), id + ':' + key);
    assert.equal(evaluated.limits.active_members, contract.max_members); assert.equal(evaluated.limits.enforcement, 'advisory');
  }
});
test('Enterprise requires positive price and capacities, annual offers and invalid dependencies are rejected', () => {
  assert.throws(() => buildPlanContract(plan('ENTERPRISE_2026')), /PRICE_REQUIRED/);
  assert.throws(() => buildPlanContract(plan('ENTERPRISE_2026'), { monthly_amount: 899 }), /CAPACITY_REQUIRED/);
  assert.throws(() => buildPlanContract(plan('ENTERPRISE_2026'), { monthly_amount: 899, max_members: 0, max_campuses: 0 }), /CAPACITY_REQUIRED/);
  assert.throws(() => buildPlanContract(plan('CUIDAR'), { billing_cycle: 'YEARLY' }), /BILLING_CYCLE_NOT_DEFINED/);
  const invalid = plan('CONECTAR'); invalid.entitlements['volunteers.module_enabled'] = true;
  assert.throws(() => buildPlanContract(invalid), /DEPENDENCY/);
});
test('tenant and campus overrides cannot purchase modules; locally disabling a contracted resource still works', async () => {
  scenario.flags = [
    { organization_id: 'org-a', campus_id: 'campus-a', feature_key: 'kids.module_enabled', is_enabled: 1 },
    { organization_id: 'org-a', feature_key: 'pdv.module_enabled', is_enabled: 1 },
    { organization_id: 'org-a', feature_key: 'future.module_enabled', is_enabled: 1 }
  ];
  let evaluated = await evaluateTenantFlags('org-a', 'campus-a');
  for (const key of ['kids.module_enabled', 'pdv.module_enabled', 'future.module_enabled']) assert.equal(evaluated.flags[key], false);
  usePlan('CUIDAR'); scenario.flags = [{ organization_id: 'org-a', feature_key: 'kids.module_enabled', is_enabled: 0 }];
  evaluated = await evaluateTenantFlags('org-a');
  assert.equal(evaluated.flags['kids.module_enabled'], false);
  assert.equal(evaluated.catalog.find(item => item.key === 'kids.module_enabled').contracted, true);
});
test('unknown plan, missing new contract and missing organization fail closed; legacy is not remapped', async () => {
  scenario.organization.plan_contract = null;
  await assert.rejects(evaluateTenantFlags('org-a'), /PLAN_CONTRACT_REQUIRED/);
  scenario.organization.plan = 'UNKNOWN'; await assert.rejects(evaluateTenantFlags('org-a'), /PLAN_CONTRACT_REQUIRED/);
  scenario.organization = null; await assert.rejects(evaluateTenantFlags('org-a'), /ORGANIZATION_NOT_FOUND/);
  scenario.organization = { id: 'org-a', plan: 'PRO' };
  assert.equal((await evaluateTenantFlags('org-a')).contract_version, undefined);
  assert.equal(await enforcePlanAccess(event(), 'events.module_enabled'), null);
});
test('direct APIs deny excluded modules for authenticated and anonymous callers and reject tenant confusion', async () => {
  for (const feature of ['kids.module_enabled', 'events.module_enabled', 'pdv.module_enabled', 'pastoral.module_enabled', 'visitors.module_enabled', 'ministries.module_enabled', 'financial.cashflow_ledger']) {
    assert.equal((await enforcePlanAccess(event(), feature)).statusCode, 403);
    scenario.user = null; assert.equal((await enforcePlanAccess(event(), feature)).statusCode, 403); scenario.user = { ...user };
  }
  assert.equal(await enforcePlanAccess(event(), 'financial.online_pix_giving'), null);
  assert.equal((await enforcePlanAccess(event({ organization_id: 'org-b' }), 'events.module_enabled')).statusCode, 403);
  assert.equal((await enforcePlanAccess(event({}, { headers: { 'x-organization-id': 'org-b' } }), 'events.module_enabled')).statusCode, 403);
});
test('flag toggling and a mixed batch reject excluded features before any write', async () => {
  assert.equal((await flagsApi.toggleFeatureFlag(event({ feature_key: 'kids.module_enabled', is_enabled: true }))).statusCode, 403);
  assert.equal((await flagsApi.batchUpdateFeatureFlags(event({ flags: [{ feature_key: 'members.digital_card', is_enabled: false }, { feature_key: 'events.module_enabled', is_enabled: true }] }))).statusCode, 403);
  assert.equal(scenario.calls.filter(call => /^\s*(INSERT|UPDATE)/.test(call.sql)).length, 0);
});
test('proposal takes its matrix from the saved plan, ignoring client descriptions and forged entitlements', async () => {
  scenario.user = { ...user, role: 'SUPERADMIN', isSuperAdmin: true }; scenario.plan = plan('CONECTAR');
  const result = await proposals.createProposal(event({ church_name: 'Igreja', contact_name: 'Pastor', contact_email: 'p@example.org', plan_tier: 'CONECTAR', monthly_amount: 99, features_included: ['Kids grátis'], entitlements: { 'kids.module_enabled': true } }));
  assert.equal(result.statusCode, 201);
  const contract = JSON.parse(scenario.calls.find(call => call.sql.includes('INSERT INTO saas_proposals')).params.at(-1));
  assert.equal(contract.entitlements['kids.module_enabled'], false); assert.equal(contract.max_members, 300); assert.equal(contract.features.includes('Kids grátis'), false);
  assert.equal(scenario.audits[0].action, 'CREATE_SAAS_PROPOSAL');
});
test('verified provisioning writes the entire contracted matrix transactionally for all four tiers', async () => {
  for (const id of ['CONECTAR', 'CUIDAR', 'GESTAO', 'ENTERPRISE_2026']) {
    const contract = usePlan(id);
    const proposal = { id: 'proposal-a', plan_tier: id, plan_contract: JSON.stringify(contract), church_name: 'Igreja', suggested_slug: 'igreja', contact_name: 'Pastor', contact_email: 'p@example.org', asaas_subscription_id: 'sub-verified' };
    const state = transaction(proposal); const result = await ProvisioningService.provisionFromProposal(proposal.id);
    assert.equal(state.commits, 1); assert.equal(state.rollbacks, 0); assert.equal(state.releases, 1);
    const rows = state.writes.filter(call => call.sql.includes('INSERT INTO tenant_feature_flags'));
    assert.equal(rows.length, Object.keys(contract.entitlements).length);
    const pilotOnly=new Set(Object.keys(require('../migrate_intelligence_journeys.js').additions));
    for (const row of rows) {
      assert.equal(row.params[1], result.organization_id);
      const expected=pilotOnly.has(row.params[2])&&result.organization_id!=='org_default'?false:contract.entitlements[row.params[2]];
      assert.equal(Boolean(row.params[3]),expected,row.params[2]);
    }
    assert.deepEqual(JSON.parse(state.writes.find(call=>call.sql.includes('UPDATE organizations SET plan_contract')).params[0]).entitlements,contract.entitlements);
    assert.equal(JSON.parse(state.writes.find(call => call.sql.includes('UPDATE organizations SET plan_contract')).params[0]).max_members, contract.max_members);
  }
});
test('provisioning rejects unverified payment and missing contracts, and retry is idempotent', async () => {
  const proposal = { id: 'proposal-a', plan_tier: 'CUIDAR', church_name: 'Igreja', asaas_subscription_id: 'sub-unverified' };
  let state = transaction(proposal); scenario.verified = false;
  await assert.rejects(ProvisioningService.provisionFromProposal('proposal-a'), /VERIFIED_ASAAS_SUBSCRIPTION_REQUIRED/);
  assert.equal(state.writes.length, 0); assert.equal(state.rollbacks, 1);
  scenario.verified = true; state = transaction(proposal);
  await assert.rejects(ProvisioningService.provisionFromProposal('proposal-a'), /PLAN_CONTRACT_REQUIRED/);
  assert.equal(state.writes.length, 0); assert.equal(state.rollbacks, 1);
  state = transaction({ id: 'proposal-a', created_organization_id: 'org-existing', church_name: 'Igreja' });
  assert.equal((await ProvisioningService.provisionFromProposal('proposal-a')).already_provisioned, true); assert.equal(state.writes.length, 0);
});
test('manual creation initializes saved plan flags; plan changes require explicit confirmation', async () => {
  scenario.user = { ...user, role: 'SUPERADMIN', isSuperAdmin: true }; scenario.plan = plan('CONECTAR');
  let state = transaction({});
  assert.equal((await organizations.createOrUpdateOrganization(event({ name: 'Igreja', slug: 'igreja', plan: 'CONECTAR' }))).statusCode, 200);
  assert.equal(state.writes.filter(call => call.sql.includes('INSERT INTO tenant_feature_flags')).length, Object.keys(scenario.plan.entitlements).length);
  state = transaction({});
  assert.equal((await organizations.createOrUpdateOrganization(event({ id: 'org-a', name: 'Igreja', slug: 'igreja', plan: 'CUIDAR' }))).statusCode, 409);
  assert.equal(state.writes.length, 0);
});
test('downgrade preserves records, and later catalog changes cannot rewrite a signed snapshot', async () => {
  const writes = []; const contract = usePlan('CONECTAR');
  await initializePlanEntitlements('org-a', contract, async (sql, params) => writes.push({ sql, params }));
  assert.ok(writes.every(call => !/\bDELETE\b/.test(call.sql)));
  assert.equal(applyContractEntitlements({ 'kids.module_enabled': true }, contract)['kids.module_enabled'], false);
  const changed = plan('CONECTAR'); changed.entitlements['kids.module_enabled'] = true;
  assert.equal(readPlanContract(JSON.stringify(contract), 'CONECTAR').entitlements['kids.module_enabled'], false);
  assert.throws(() => readPlanContract(contract, 'CUIDAR'), /MISMATCH/);
});

test('the actual module handlers enforce the contract even when called outside the consolidated router', async () => {
  const cases = [
    ['kids', 'getRooms'], ['ministries', 'listMinistries'], ['pastoralCare', 'registerVisitor'], ['pastoralCare', 'getAbsenteeismRadar'],
    ['events', 'getEvents'], ['tickets', 'checkout'], ['pdv_products', 'getProducts'], ['pdv_orders', 'createOrder'],
    ['pdv_inventory', 'getInventory'], ['financial', 'getFinancialSummary']
  ];
  for (const [file, name] of cases) {
    const result = await require(`../src/functions/${file}.ts`)[name](event());
    assert.equal(result.statusCode, 403, `${file}.${name}`);
    assert.equal(JSON.parse(result.body).error, 'PLAN_FEATURE_NOT_INCLUDED');
  }
  assert.ok(scenario.calls.every(call => /FROM organizations|FROM tenant_feature_flags/.test(call.sql)));
});
test('capacity excess is advisory, unique active members are organizational, and old list prices never become invoices', async () => {
  const contract = usePlan('GESTAO');
  scenario.query = async sql => ({ rows: [{ id: 'org-a', plan: 'GESTAO', plan_contract: JSON.stringify(contract), active_members: 1501, total_members: 2500, active_campuses: 5 }] });
  const result = await organizations.listOrganizations(event());
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.match(body.data[0].capacity_warning, /operação permanece disponível/);
  assert.equal(body.data[0].plan_contract.max_members, 1500);
  assert.ok(scenario.calls[0].sql.includes('COUNT(DISTINCT CASE WHEN UPPER(m.status)'));
  assert.ok(scenario.calls[0].sql.includes("NOT IN ('VISITOR','VISITANTE','GUEST')"));
});

test('feature override identifiers fit the real production schema and keep tenant/campus isolation', async () => {
  const { setFeatureFlagOverride } = require('../src/services/featureFlagService.ts');
  const base = { organizationId: 'organization-with-a-long-identifier', featureKey: 'secretariat.public_verification', isEnabled: false };
  await setFeatureFlagOverride(base);
  await setFeatureFlagOverride(base);
  await setFeatureFlagOverride({ ...base, campusId: 'campus-a' });
  await setFeatureFlagOverride({ ...base, organizationId: 'other-organization' });
  const writes = scenario.calls.filter(call => call.sql.includes('INSERT INTO tenant_feature_flags'));
  assert.ok(writes.every(call => call.params[0].length <= 36));
  assert.equal(writes[0].params[0], writes[1].params[0]);
  assert.notEqual(writes[0].params[0], writes[2].params[0]);
  assert.notEqual(writes[0].params[0], writes[3].params[0]);
});

test('trial expiry and pending start disable contracted modules but preserve activation flags', async () => {
  for (const patch of [{trial_pending_start:1},{trial_expires_at:'2020-01-01T00:00:00Z'}]) {
    usePlan('CONECTAR'); Object.assign(scenario.organization,patch);
    scenario.flags=[{organization_id:'global',feature_key:'system.saas_public_onboarding',is_enabled:1}];
    const evaluated=await evaluateTenantFlags('org-a');
    assert.equal(evaluated.flags['members.module_enabled'],false);
    assert.equal(evaluated.flags['system.saas_public_onboarding'],true);
  }
});
test('verified trial conversion keeps tenant and seeds newly purchased modules at its sede', async () => {
  const contract=usePlan('GESTAO');
  scenario.acquisition={id:'acq',mode:'TRIAL',organization_id:'org-a',owner_sub:'owner'};
  scenario.owner={id:'owner'};
  const proposal={id:'proposal-a',plan_tier:'GESTAO',plan_contract:JSON.stringify(contract),asaas_subscription_id:'sub-paid',contact_email:'owner@example.org'};
  const state=transaction(proposal);
  const result=await ProvisioningService.provisionFromProposal(proposal.id);
  assert.equal(result.organization_id,'org-a');assert.equal(state.commits,1);
  assert.equal(state.writes.some(c=>c.sql.includes('INSERT INTO organizations')),false);
  assert.equal(state.writes.some(c=>c.sql.includes('trial_pending_start = 0')),true);
  assert.equal(scenario.seeds[0][0],'org-a');assert.equal(scenario.seeds[0][1],'campus-trial');
});
