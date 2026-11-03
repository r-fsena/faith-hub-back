process.env.AWS_EC2_METADATA_DISABLED = "true";
delete process.env.USER_POOL_ID;
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  ts = require("typescript");
require.extensions[".ts"] = (m, f) =>
  m._compile(
    ts.transpileModule(fs.readFileSync(f, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
    }).outputText,
    f,
  );
let state;
const mock = (path, exports) => {
  const p = require.resolve(path);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const response = (statusCode, body) => ({
  statusCode,
  body: JSON.stringify(body),
});
const owner = {
  sub: "verified-owner",
  email: "owner@example.org",
  name: "Responsável",
};
const catalog = require("../src/config/commercialPlans.json");
const { buildPlanContract } = require("../src/services/planCatalog.ts");
const plan = (id) => structuredClone(catalog.plans.find((p) => p.id === id));
async function dbQuery(sql, params = []) {
  assert.equal((sql.match(/\?/g) || []).length, params.length, sql);
  state.calls.push({ sql, params });
  if (sql.includes("FROM members")) return { rows: state.members };
  if (sql.includes("FROM saas_acquisitions"))
    return { rows: state.row ? [state.row] : [] };
  if (sql.includes("FROM saas_plans"))
    return { rows: params[0] ? [plan(params[0])] : catalog.plans };
  if (sql.startsWith("INSERT INTO saas_acquisitions")) {
    state.row = {
      id: params[0],
      owner_sub: params[1],
      owner_email: params[2],
      plan_id: params[7],
      mode: params[8],
      status: params[9],
      plan_contract: params[10],
    };
    return { rows: { affectedRows: 1 } };
  }
  if (sql.includes("FROM saas_proposals"))
    return { rows: [{ token: "existing-checkout" }] };
  throw Error("Unexpected query: " + sql);
}
mock("../src/db/index.ts", {
  query: dbQuery,
  apiResponse: response,
  getConnection: async () => ({
    beginTransaction: async () => {},
    commit: async () => state.commits++,
    rollback: async () => state.rollbacks++,
    release: () => {},
    query: async (sql, params = []) => {
      assert.equal((sql.match(/\?/g) || []).length, params.length, sql);
      state.calls.push({ sql, params });
      if (sql.includes("FROM saas_acquisitions"))
        return [state.row ? [state.row] : []];
      if (/^\s*(INSERT|UPDATE)/.test(sql)) {
        state.writes.push({ sql, params });
        return [{ affectedRows: 1 }];
      }
      throw Error("Unexpected transaction query: " + sql);
    },
  }),
});
mock("../src/services/featureFlagService.ts", {
  evaluateTenantFlags: async () => ({
    flags: {
      "system.saas_public_journey": state.enabled,
      "system.saas_public_checkout": state.checkout,
    },
  }),
});
mock("../src/services/planProvisioning.ts", {
  initializePlanEntitlements: async (...args) => state.entitlements.push(args),
});
mock("../src/services/tokenVerifier.ts", {
  getVerifiedClaims: async () => state.claims,
});
mock("../src/services/rateLimiter.ts", {
  checkRateLimit: async () => ({
    allowed: state.rate,
    errorResponse: response(429, {}),
  }),
});
mock("../src/services/auditLogService.ts", {
  logSecurityEvent: async () => {},
});
mock("../src/functions/proposals.ts", {
  acceptProposal: async () => {
    state.accepts++;
    return response(200, {
      payment_link: "https://asaas.com/checkoutSession/show?id=test",
    });
  },
});
const journey = require("../src/services/publicJourney.ts");
const { publicJourneyHandler } = require("../src/functions/publicJourney.ts");
const validBody = (id = "CONECTAR", mode = "TRIAL") => ({
  plan_id: id,
  mode,
  church_name: "Igreja teste",
  contact_name: "Responsável",
  document: "52998224725",
  termsAccepted: true,
  terms_version: journey.TERMS_VERSION,
  offer_revision: journey.offerRevision(
    buildPlanContract(plan(id), { billing_cycle: "MONTHLY" }),
  ),
});
const event = (path, method = "POST", body = {}) => ({
  path: "/public/journey" + path,
  httpMethod: method,
  headers: {},
  body: JSON.stringify(body),
  requestContext: {},
});
beforeEach(() => {
  state = {
    calls: [],
    writes: [],
    members: [],
    row: null,
    commits: 0,
    rollbacks: 0,
    accepts: 0,
    entitlements: [],
    enabled: true,
    checkout: true,
    rate: true,
    claims: {
      sub: owner.sub,
      email: owner.email,
      email_verified: true,
      token_use: "id",
    },
  };
});
test("approved offers expose trial exclusively on Conectar", async () => {
  const r = await journey.publicOffers();
  assert.deepEqual(
    r.plans.map((p) => [p.id, p.monthly_price, p.trial_available]),
    [
      ["CONECTAR", 99, true],
      ["CUIDAR", 249, false],
      ["GESTAO", 399, false],
      ["ENTERPRISE_2026", null, false],
    ],
  );
  assert.equal(r.trial.days, 14);
  assert.ok(r.plans[0].offer_revision);
});
test("trial on Cuidar or Gestão is rejected before writes", async () => {
  for (const id of ["CUIDAR", "GESTAO"])
    await assert.rejects(
      journey.createAcquisition(owner, validBody(id)),
      (e) => e.status === 400,
    );
  assert.equal(state.writes.length, 0);
});
test("prices, modules, tenant and capacities cannot be injected", async () => {
  for (const key of [
    "monthly_amount",
    "monthly_price",
    "entitlements",
    "organization_id",
    "max_members",
    "max_campuses",
    "discount_type",
  ])
    await assert.rejects(
      journey.createAcquisition(owner, { ...validBody(), [key]: "forged" }),
      (e) => e.status === 400,
    );
});
test("terms and offer revision must match the reviewed offer", async () => {
  await assert.rejects(
    journey.createAcquisition(owner, { ...validBody(), termsAccepted: false }),
    (e) => e.status === 400,
  );
  await assert.rejects(
    journey.createAcquisition(owner, {
      ...validBody(),
      offer_revision: "stale",
    }),
    (e) => e.status === 409,
  );
});
test("request is idempotent and creates no tenant or checkout", async () => {
  const a = await journey.createAcquisition(owner, validBody());
  const b = await journey.createAcquisition(owner, validBody());
  assert.equal(a.id, b.id);
  assert.equal(a.status, "TRIAL_REQUESTED");
  assert.equal(state.accepts, 0);
  assert.equal(state.entitlements.length, 0);
  assert.equal(
    state.calls.filter((c) => c.sql.startsWith("INSERT INTO saas_acquisitions"))
      .length,
    1,
  );
});
test("existing church identity is rejected before payment", async () => {
  state.members = [{ organization_id: "other-church" }];
  await assert.rejects(
    journey.createAcquisition(owner, validBody("CUIDAR", "PAID")),
    (e) => e.status === 409,
  );
});
test("paid requests require valid CPF/CNPJ", async () => {
  assert.equal(journey.validDocument("52998224725"), true);
  assert.equal(journey.validDocument("11222333000181"), true);
  for (const v of ["11111111111", "52998224726", "11222333000180", ""])
    assert.equal(journey.validDocument(v), false);
  await assert.rejects(
    journey.createAcquisition(owner, {
      ...validBody("GESTAO", "PAID"),
      document: "123",
    }),
    (e) => e.status === 400,
  );
});
test("paid request preserves catalog snapshot without provisioning", async () => {
  const r = await journey.createAcquisition(owner, validBody("CUIDAR", "PAID"));
  const c = JSON.parse(r.plan_contract);
  assert.equal(c.monthly_price, 249);
  assert.equal(c.entitlements["kids.module_enabled"], true);
  assert.equal(r.status, "DRAFT");
  assert.equal(state.accepts, 0);
});
test("absent, unverified and access tokens cannot create requests", async () => {
  const good = state.claims;
  for (const claims of [
    null,
    { ...good, email_verified: false },
    { ...good, token_use: "access" },
  ]) {
    state.claims = claims;
    assert.equal(
      (await publicJourneyHandler(event("/requests", "POST", validBody())))
        .statusCode,
      401,
    );
  }
  assert.equal(state.calls.length, 0);
});
test("anonymous offers are rate limited", async () => {
  state.rate = false;
  assert.equal(
    (await publicJourneyHandler(event("/offers", "GET"))).statusCode,
    429,
  );
});
test("lookup binds verified owner and unknown IDs return 404", async () => {
  assert.equal(
    (
      await publicJourneyHandler(
        event("/requests/11111111-1111-1111-1111-111111111111", "GET"),
      )
    ).statusCode,
    404,
  );
  const lookup = state.calls.find((c) =>
    c.sql.includes("FROM saas_acquisitions"),
  );
  assert.match(lookup.sql, /owner_sub = \?/);
  assert.equal(lookup.params[0], owner.sub);
});
test("disabled checkout cannot issue provider checkout", async () => {
  state.checkout = false;
  await assert.rejects(
    journey.createPublicProposal(owner, "request"),
    (e) => e.status === 503,
  );
  assert.equal(state.accepts, 0);
});
test("trial cannot convert before Master approval", async () => {
  state.row = {
    mode: "TRIAL",
    status: "TRIAL_REQUESTED",
    organization_id: null,
  };
  await assert.rejects(
    journey.createPublicProposal(owner, "request"),
    (e) => e.status === 409,
  );
  assert.equal(state.rollbacks, 1);
  assert.equal(state.writes.length, 0);
});
test("conversion requires consent and same-tenant identity", async () => {
  state.row = { mode: "TRIAL", organization_id: "org-own" };
  await assert.rejects(
    journey.createPublicProposal(owner, "request"),
    (e) => e.status === 400,
  );
  state.members = [{ organization_id: "other-org" }];
  await assert.rejects(
    journey.createPublicProposal(owner, "request", validBody("GESTAO", "PAID")),
    (e) => e.status === 409,
  );
});
test("checkout retries reuse existing proposal", async () => {
  state.row = { proposal_id: "existing" };
  assert.deepEqual(await journey.createPublicProposal(owner, "request"), {
    token: "existing-checkout",
  });
  assert.equal(state.writes.length, 0);
});
test("approval retries reuse tenant and paid plans cannot receive trial", async () => {
  state.row = {
    mode: "TRIAL",
    plan_id: "CONECTAR",
    organization_id: "org-ready",
  };
  assert.deepEqual(
    await journey.approveTrial("request", "master@example.org"),
    { organization_id: "org-ready" },
  );
  assert.equal(state.writes.length, 0);
  state.row = { mode: "PAID", plan_id: "GESTAO" };
  await assert.rejects(
    journey.approveTrial("request", "master@example.org"),
    (e) => e.status === 409,
  );
});
test("trial retries never extend clock; paid conversion cannot restart it", async () => {
  state.row = {
    mode: "TRIAL",
    plan_id: "CONECTAR",
    status: "TRIAL_ACTIVE",
    trial_started_at: "2026-11-03",
    trial_expires_at: "2026-11-17",
  };
  await journey.startTrial(owner, "request", "org-own");
  assert.equal(state.writes.length, 0);
  state.row.status = "ACTIVE";
  await assert.rejects(
    journey.startTrial(owner, "request", "org-own"),
    (e) => e.status === 409,
  );
});
test("first start updates request and tenant in same transaction", async () => {
  state.row = {
    mode: "TRIAL",
    plan_id: "CONECTAR",
    status: "TRIAL_READY",
    trial_started_at: null,
  };
  await journey.startTrial(owner, "request", "org-own");
  assert.equal(state.writes.length, 2);
  assert.match(state.writes[0].sql, /INTERVAL 14 DAY/);
  assert.match(state.writes[1].sql, /a.owner_sub = \?/);
  assert.equal(state.commits, 1);
});

test('first approval creates only Conectar tenant, sede and verified owner transactionally',async()=>{
 state.row={id:'request',mode:'TRIAL',plan_id:'CONECTAR',status:'TRIAL_REQUESTED',owner_sub:owner.sub,owner_email:owner.email,contact_name:owner.name,church_name:'Igreja',document:null,plan_contract:JSON.stringify(buildPlanContract(plan('CONECTAR'),{billing_cycle:'MONTHLY'}))};
 const result=await journey.approveTrial('request','master@example.org');
 assert.match(result.organization_id,/^org_/);assert.equal(state.commits,1);
 assert.equal(state.entitlements.length,1);assert.equal(state.entitlements[0][1].entitlements['kids.module_enabled'],false);
 assert.ok(state.writes.some(c=>c.sql.includes('trial_pending_start = 1')));
 assert.ok(state.writes.some(c=>c.sql.includes('INSERT INTO members')&&c.params[0]===owner.sub));
 assert.equal(state.writes.some(c=>c.sql.includes('INTERVAL 14 DAY')),false);
});
test('paid proposal records accepted catalog amount and no free-month discount',async()=>{
 state.row={id:'request',mode:'PAID',plan_id:'CUIDAR',owner_sub:owner.sub,owner_email:owner.email,contact_name:owner.name,church_name:'Igreja',document:'52998224725',organization_id:null,plan_contract:JSON.stringify(buildPlanContract(plan('CUIDAR'),{billing_cycle:'MONTHLY'}))};
 await journey.createPublicProposal(owner,'request');
 const proposal=state.writes.find(c=>c.sql.includes('INSERT INTO saas_proposals'));
 assert.match(proposal.sql,/'NONE',0/);assert.ok(proposal.params.includes(249));assert.equal(state.commits,1);assert.equal(state.entitlements.length,0);
});
test('Master endpoints reject non-Master and unauthenticated sessions',async()=>{
 state.members=[{id:owner.sub,name:owner.name,email:owner.email,organization_id:'org-own',role:'ADMIN',status:'ACTIVE',campus_ids:'["all"]'}];
 assert.equal((await publicJourneyHandler(event('/admin','GET'))).statusCode,403);
 state.claims=null;assert.equal((await publicJourneyHandler(event('/admin','GET'))).statusCode,401);
});
