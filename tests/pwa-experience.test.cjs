process.env.AWS_EC2_METADATA_DISABLED = "true";
const { test, beforeEach } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  ts = require("typescript");
require.extensions[".ts"] = (m, f) =>
  m._compile(
    ts.transpileModule(fs.readFileSync(f, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText,
    f,
  );
const c = require("../src/config/pwaExperience.ts");
let state;
async function execute(sql, params = [], tx = false) {
  assert.equal((sql.match(/\?/g) || []).length, params.length, sql);
  state.calls.push({ sql, params, tx });
  if (sql.includes("INSERT INTO security_audit_logs") && state.auditFail)
    throw Error("AUDIT_UNAVAILABLE");
  let rows = [];
  if (sql.includes("FROM organizations")) rows = [{ id: "org-a" }];
  else if (sql.includes("FROM campuses"))
    rows = state.campus ? [{ id: "campus-a" }] : [];
  else if (sql.includes("FROM church_settings"))
    rows = [{ primary_color: "#0f766e", church_name: "Comunidade" }];
  else if (sql.includes("FROM pwa_experience_versions")) rows = state.versions;
  else if (sql.includes("FROM pwa_experience_scopes")) rows = sql.includes('campus_id IS NOT NULL')?(state.campusVersions||[]):state.rows;
  else if (/^\s*(INSERT|UPDATE)/.test(sql)) {
    state.writes.push({ sql, params });
    rows = { affectedRows: 1 };
  } else throw Error("Unexpected SQL " + sql);
  return tx ? [rows] : { rows };
}
function mock(file, exports) {
  const p = require.resolve(file);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
mock("../src/db/index.ts", {
  query: (s, p) => execute(s, p),
  apiResponse: (statusCode, body) => ({
    statusCode,
    body: JSON.stringify(body),
  }),
  getConnection: async () => ({
    beginTransaction: async () => {},
    commit: async () => state.commits++,
    rollback: async () => state.rollbacks++,
    release: () => {},
    query: (s, p) => execute(s, p, true),
  }),
});
mock("../src/services/featureFlagService.ts", {
  evaluateTenantFlags: async () => ({
    flags: { [c.EXPERIENCE_FLAG]: state.enabled },
  }),
});
mock("../src/services/rateLimiter.ts", {
  checkRateLimit: async () => ({
    allowed: state.rate,
    errorResponse: { statusCode: 429, body: "{}" },
  }),
});
const auth = require("../src/services/authMiddleware.ts");
auth.requireAuth = async () =>
  state.user
    ? { user: state.user }
    : { errorResponse: { statusCode: 401, body: "{}" } };
const s = require("../src/services/pwaExperienceService.ts"),
  { pwaExperienceHandler: h } = require("../src/functions/pwaExperience.ts");
const user = {
    userId: "admin",
    email: "admin@example.test",
    name: "Admin",
    role: "ADMIN",
    organizationId: "org-a",
    campusIds: ["campus-a"],
    isSuperAdmin: false,
    operationalPermissions: [],
  },
  audit = { organizationId: "org-a", user, action: "", resource: "" };
const event = (route, method = "GET", body = {}) => ({
  httpMethod: method,
  path: "/pwa-experience/" + route,
  headers: { "x-organization-id": "org-a" },
  queryStringParameters: { organization_id: "org-a" },
  body: JSON.stringify(body),
});
beforeEach(() => {
  state = {
    calls: [],
    writes: [],
    rows: [],
    versions: [],
    enabled: true,
    rate: true,
    campus: true,
    user: { ...user },
    commits: 0,
    rollbacks: 0,
  };
});
test("shared contract is identical across all repositories", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/config/pwaExperience.ts"),
    "utf8",
  );
  for (const repo of ["faith-hub-web", "faith-hub-pwa"])
    assert.equal(
      fs.readFileSync(
        path.join(__dirname, "../../", repo, "src/config/pwaExperience.ts"),
        "utf8",
      ),
      source,
    );
});
test("all presets have readable palettes in both modes", () => {
  for (const id of ["classic", "welcoming", "contemporary"])
    assert.deepEqual(c.contrastIssues(c.preset(id)), []);
});
test("legacy brand and nested inheritance preserve untouched fields", () => {
  const config = c.resolveExperience(
    { primary_color: "#334455", theme_mode: "AUTO" },
    { theme: { light: { background: "#fff7ed" } } },
    { copy: { "home.title": "Centro" } },
  );
  assert.equal(config.theme.light.primary, "#334455");
  assert.equal(config.theme.default_mode, "AUTO");
  assert.equal(config.theme.light.background, "#fff7ed");
  assert.equal(config.copy["home.title"], "Centro");
  assert.deepEqual(c.defaultExperience().copy, {});
});
test("schema rejects scripts, CSS, unknown keys, null groups and unsafe fonts", () => {
  for (const v of [
    { flags: {} },
    { theme: { light: { primary: "red;display:none" } } },
    { identity: { logo_url: "javascript:alert(1)" } },
    { screens: { other: {} } },
    { theme: null },
    { theme: { light: null } },
    { copy: { "payment.confirmed": "Pago" } },
    { copy: null },
    { theme: { typography: { font: "url(https://bad.test)" } } },
  ])
    assert.throws(() => c.validatePatch(v), /Configuração inválida/);
});
test("schema rejects oversized copy and duplicate or omitted blocks", () => {
  assert.throws(() =>
    c.validatePatch({ copy: { "home.title": "x".repeat(81) } }),
  );
  const config = c.defaultExperience();
  config.home.blocks[1] = config.home.blocks[0];
  assert.throws(() => c.validatePatch({ home: config.home }));
  assert.throws(() => c.validatePatch({ home: { blocks: [] } }));
});
test("global and screen contrast are checked independently", () => {
  assert.ok(
    c.contrastIssues(
      c.resolveExperience({}, { theme: { light: { text: "#ffffff" } } }),
    ).length,
  );
  assert.ok(
    c
      .contrastIssues(
        c.resolveExperience(
          {},
          { screens: { events: { palette: { text: "#ffffff" } } } },
        ),
      )
      .some((v) => v.includes("events")),
  );
});
test("preflight is public but editing requires authentication", async () => {
  state.user = null;
  assert.equal((await h(event("draft", "OPTIONS"))).statusCode, 204);
  for (const action of ["editor", "draft", "publish", "restore"])
    assert.equal(
      (await h(event(action, action === "editor" ? "GET" : "POST"))).statusCode,
      401,
    );
});
test("RBAC, tenant guard and conflicting scope sources prevent access", async () => {
  state.user.role = "MEMBER";
  assert.equal((await h(event("editor"))).statusCode, 403);
  state.user = { ...user };
  const e = event("editor");
  e.queryStringParameters.organization_id = e.headers["x-organization-id"] =
    "org-b";
  assert.equal((await h(e)).statusCode, 403);
  assert.equal(
    (await h(event("draft", "POST", { organization_id: "org-b" }))).statusCode,
    403,
  );
  assert.equal(state.writes.length, 0);
});
test("foreign or unauthorized campuses are rejected", async () => {
  const e = event("editor");
  e.queryStringParameters.campus_id = "campus-b";
  state.campus = false;
  assert.equal((await h(e)).statusCode, 404);
  state.campus = true;
  assert.equal((await h(e)).statusCode, 403);
});
test("disabled feature blocks editing and returns no published experience", async () => {
  state.enabled = false;
  assert.equal((await h(event("editor"))).statusCode, 403);
  assert.equal((await s.publishedExperience("org-a", null)).config, null);
});
test("public response is scoped and never exposes draft contents", async () => {
  state.rows = [
    {
      scope_key: "organization",
      published_json: { copy: { "home.title": "Publicado" } },
      published_revision: 2,
      draft_json: { copy: { "home.title": "Privado" } },
    },
  ];
  const result = await s.publishedExperience("org-a", null);
  assert.equal(result.config.copy["home.title"], "Publicado");
  assert.equal(JSON.stringify(result).includes("Privado"), false);
  assert.ok(
    state.calls
      .find((v) => v.sql.includes("published_revision"))
      .params.includes("org-a"),
  );
});
test("creating a draft locks the tenant and audits without publishing", async () => {
  const result = await s.changeExperience(
    "org-a",
    null,
    "draft",
    { expected_revision: 0, config: { copy: { "home.title": "Rascunho" } } },
    audit,
  );
  assert.equal(result.revision, 1);
  assert.equal(result.published_revision, 0);
  assert.equal(state.commits, 1);
  assert.ok(state.writes.some((v) => v.sql.includes("security_audit_logs")));
  assert.equal(
    state.writes.some((v) => v.sql.includes("pwa_experience_versions")),
    false,
  );
});
test("stale revisions roll back with no writes", async () => {
  state.rows = [{ revision: 4 }];
  await assert.rejects(
    s.changeExperience(
      "org-a",
      null,
      "draft",
      { expected_revision: 3, config: {} },
      audit,
    ),
    (e) => e.status === 409,
  );
  assert.equal(state.rollbacks, 1);
  assert.equal(state.writes.length, 0);
});
test("publication validates inheritance and appends an audited version", async () => {
  state.rows = [
    {
      revision: 1,
      published_revision: 0,
      draft_json: { copy: { "home.title": "Nova home" } },
    },
  ];
  const result = await s.changeExperience(
    "org-a",
    null,
    "publish",
    { expected_revision: 1 },
    audit,
  );
  assert.equal(result.published_revision, 2);
  assert.equal(state.commits, 1);
  assert.ok(
    state.writes.some((v) =>
      v.sql.includes("INSERT INTO pwa_experience_versions"),
    ),
  );
});
test("missing draft or invalid contrast cannot replace published config", async () => {
  state.rows = [
    { revision: 1, draft_json: { theme: { light: { text: "#ffffff" } } } },
  ];
  await assert.rejects(
    s.changeExperience(
      "org-a",
      null,
      "publish",
      { expected_revision: 1 },
      audit,
    ),
    (e) => e.status === 422,
  );
  assert.equal(state.writes.length, 0);
  state.rows = [{ revision: 1, draft_json: null }];
  await assert.rejects(
    s.changeExperience(
      "org-a",
      null,
      "publish",
      { expected_revision: 1 },
      audit,
    ),
    (e) => e.status === 409,
  );
});
test("restoring scoped history creates a draft, not a publication", async () => {
  state.rows = [{ revision: 3, published_revision: 2 }];
  state.versions = [{ config_json: { copy: { "home.title": "Anterior" } } }];
  const result = await s.changeExperience(
    "org-a",
    "campus-a",
    "restore",
    { expected_revision: 3, version_id: "old" },
    audit,
  );
  assert.equal(result.published_revision, 2);
  assert.ok(
    state.calls
      .find((v) => v.sql.includes("config_json FROM"))
      .params.includes("campus:campus-a"),
  );
  assert.equal(
    state.writes.some((v) => v.sql.includes("SET published_json")),
    false,
  );
});
test("audit failure rolls back publication", async () => {
  state.rows = [{ revision: 1, draft_json: {} }];
  state.auditFail = true;
  await assert.rejects(
    s.changeExperience(
      "org-a",
      null,
      "publish",
      { expected_revision: 1 },
      audit,
    ),
    /AUDIT_UNAVAILABLE/,
  );
  assert.equal(state.commits, 0);
  assert.equal(state.rollbacks, 1);
});
test("public reads honor distributed rate limiting", async () => {
  state.rate = false;
  assert.equal((await h(event("published"))).statusCode, 429);
});

test('legacy inline logos can be rendered but cannot be saved as new patch URLs',()=>{const logo='data:image/png;base64,iVBORw0KGgo=';assert.throws(()=>c.validatePatch({identity:{logo_url:logo}}));assert.equal(c.resolveExperience({}, {identity:{logo_url:logo}}).identity.logo_url,logo);});
test('malformed tenant and campus identifiers are rejected before queries',async()=>{const e=event('published');e.queryStringParameters.organization_id='bad/id';assert.equal((await h(e)).statusCode,400);const other=event('editor');other.queryStringParameters.campus_id='bad/id';assert.equal((await h(other)).statusCode,400);assert.equal(state.calls.length,0);});

test('organization publication cannot invalidate a published campus palette',async()=>{state.rows=[{revision:1,draft_json:{}}];state.campusVersions=[{scope_key:'campus:campus-a',published_json:{theme:{light:{text:'#ffffff'}}}}];await assert.rejects(s.changeExperience('org-a',null,'publish',{expected_revision:1},audit),e=>e.status===422);assert.equal(state.commits,0);});
