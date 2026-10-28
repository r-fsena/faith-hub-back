delete process.env.ASAAS_API_KEY;
process.env.AWS_EC2_METADATA_DISABLED = 'true';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const jose = require('jose');
const issuer = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_test';
process.env.USER_POOL_ID = 'us-east-2_test';
process.env.USER_POOL_CLIENT_ID = 'test-client';
let privateKey, publicJwk, token;
let member, calls, dbQuery, connection;
const dbPath = require.resolve('../src/db/index.ts');
const response = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  apiResponse: response,
  query: async (sql, params = []) => { assert.equal((sql.match(/\?/g) || []).length, params.length, 'SQL parameter count: ' + sql); calls.push({ sql, params }); return dbQuery(sql, params); },
  getConnection: async () => connection
}};
const josePath = require.resolve('jose');
require.cache[josePath].exports = { ...jose, createRemoteJWKSet: url => {
  assert.equal(url.href, issuer + '/.well-known/jwks.json');
  return jose.createLocalJWKSet({ keys: [publicJwk] });
}};
require('@aws-sdk/client-cognito-identity-provider').CognitoIdentityProviderClient.prototype.send = async () => { throw new Error('Unexpected external Cognito call in security tests'); };
const auth = require('../src/services/authMiddleware.ts');
const { getVerifiedClaims } = require('../src/services/tokenVerifier.ts');
const pdv = require('../src/functions/pdv_orders.ts');
const tickets = require('../src/functions/tickets.ts');
const prayers = require('../src/functions/prayers.ts');
const financial = require('../src/functions/financial.ts');
const kids = require('../src/functions/kids.ts');
const gateway = require('../src/functions/pagarmeSettings.ts');
const members = require('../src/functions/members.ts');
const secretariat = require('../src/functions/secretariat.ts');
const { handleAsaasWebhook } = require('../src/functions/asaasWebhook.ts');
const event = (body = {}, overrides = {}) => ({ headers: { Authorization: `Bearer ${token}`, 'x-organization-id': 'org-a' }, body: JSON.stringify(body), requestContext: { http: { sourceIp: '127.0.0.1' } }, queryStringParameters: {}, pathParameters: {}, ...overrides });
const sign = async (payload = {}, options = {}) => new jose.SignJWT({ token_use: 'id', email: 'member@example.org', email_verified: true, ...payload }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setSubject('cognito-sub').setIssuer(options.issuer || issuer).setAudience(options.aud || 'test-client').setIssuedAt().setExpirationTime(options.exp || '5m').sign(privateKey);
function reset() {
  calls = [];
  member = { id: 'member-a', email: 'member@example.org', name: 'Membro', role: 'MEMBER', status: 'ACTIVE', organization_id: 'org-a', campus_id: 'campus_sede', operational_permissions: '[]' };
  dbQuery = async sql => ({ rows: sql.includes('FROM members') ? [member] : [] });
}
function transaction(query) {
  const state = { commits: 0, rollbacks: 0, releases: 0, writes: [] };
  connection = { query: async (sql, params) => { if (/^\s*(INSERT|UPDATE|DELETE)\b/.test(sql)) state.writes.push({ sql, params }); return [await query(sql, params)]; }, beginTransaction: async () => {}, commit: async () => { state.commits++; }, rollback: async () => { state.rollbacks++; }, release: () => { state.releases++; } };
  return state;
}
before(async () => {
  const keys = await jose.generateKeyPair('RS256'); privateKey = keys.privateKey;
  publicJwk = { ...await jose.exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
  token = await sign();
});
test('Cognito: signed identity succeeds; forged payload and fabricated gateway claims fail', async () => {
  reset(); assert.equal((await auth.requireAuth(event())).user.userId, 'member-a');
  const forged = `e30.${Buffer.from(JSON.stringify({ sub: 'cognito-sub', email: member.email, exp: 9999999999 })).toString('base64url')}.fake`;
  assert.equal(await getVerifiedClaims(event({}, { headers: { Authorization: 'Bearer ' + forged } })), null);
  assert.equal(await getVerifiedClaims(event({}, { headers: {}, requestContext: { authorizer: { jwt: { claims: { sub: 'cognito-sub' } } } } })), null);
});
test('Cognito rejects wrong issuer, audience, token use and expired signatures', async () => {
  reset();
  for (const value of [await sign({}, { issuer: 'https://attacker.example' }), await sign({}, { aud: 'another-client' }), await sign({ token_use: 'refresh' }), await sign({}, { exp: Math.floor(Date.now() / 1000) - 60 })]) {
    assert.equal(await getVerifiedClaims(event({}, { headers: { Authorization: 'Bearer ' + value } })), null);
  }
});
test('Email and org_master membership do not grant master privileges; inactive identities fail', async () => {
  reset(); member.email = 'admin@faithhub.com'; member.organization_id = 'org_master';
  assert.equal((await auth.getAuthenticatedUser(event())).isSuperAdmin, false);
  member.status = 'Inativo'; assert.equal(await auth.getAuthenticatedUser(event()), null);
  reset(); dbQuery = async () => ({ rows: [member, { ...member, id: 'duplicate' }] });
  assert.equal(await auth.getAuthenticatedUser(event()), null);
});
test('PDV recalculates prices and keeps payment pending despite manipulated client values', async () => {
  reset(); dbQuery = async (sql) => ({ rows: sql.includes('FROM members') ? [member] : sql.includes('FROM pdv_products') ? [{ id: 'product-a', name: 'Livro', price: '19.90' }] : [] });
  const result = await pdv.createOrder(event({ organization_id: 'org-a', user_name: 'Membro', payment_method: 'PIX', payment_status: 'PAID', total_price: 0.01, items_json: [{ id: 'product-a', qty: 2, price: 0.01 }] }));
  assert.equal(result.statusCode, 201); const body = JSON.parse(result.body);
  assert.equal(body.total_price, 39.8); assert.equal(body.payment_status, 'PENDING');
  const insert = calls.find(call => call.sql.includes('INSERT INTO pdv_orders'));
  assert.equal(insert.params[5], 'PENDING'); assert.equal(insert.params[9], 39.8);
});
test('PDV rejects card, negative quantities, foreign products and cross-tenant checkout', async () => {
  for (const [body, expected] of [[{ payment_method: 'CREDIT_CARD' }, 409], [{ items_json: [{ id: 'p', qty: -1 }] }, 400], [{ items_json: [{ id: 'other-tenant-product', qty: 1 }] }, 400], [{ organization_id: 'org-b' }, 403]]) {
    reset(); const result = await pdv.createOrder(event({ organization_id: 'org-a', user_name: 'Membro', payment_method: 'PIX', items_json: [{ id: 'p', qty: 1 }], ...body }));
    assert.equal(result.statusCode, expected); assert.ok(!calls.some(call => call.sql.includes('INSERT INTO pdv_orders')));
  }
});
test('Orders require authentication and ordinary members cannot select another owner', async () => {
  reset(); assert.equal((await pdv.getOrders(event({}, { headers: {} }))).statusCode, 401);
  await pdv.getOrders(event({}, { queryStringParameters: { user_id: 'victim' } }));
  const list = calls.find(call => call.sql.startsWith('SELECT * FROM pdv_orders'));
  assert.ok(list.params.includes('member-a')); assert.ok(!list.params.includes('victim'));
});
test('Tickets reject an exhausted or foreign lot without committing or emitting an admission', async () => {
  for (const lots of [[], [{ id: 'lot-a', price: 15, available_capacity: 0 }]]) {
    reset(); const state = transaction(async sql => sql.includes('FROM events WHERE') ? [{ id: 'event-a', organization_id: 'org-a' }] : sql.includes('FROM event_lots') ? lots : []);
    const result = await tickets.checkout(event({ event_id: 'event-a', lot_id: 'lot-a', organization_id: 'org-a', payment_method: 'PIX' }));
    assert.equal(result.statusCode, 409); assert.equal(state.commits, 0); assert.equal(state.writes.length, 0); assert.equal(state.releases, 1);
  }
});
test('Paid-event Pix registration remains pending; only a free lot is immediately released', async () => {
  for (const price of [20, 0]) {
    reset(); const state = transaction(async sql => sql.includes('FROM events WHERE') ? [{ id: 'event-a', organization_id: 'org-a' }] : sql.includes('FROM event_lots') ? [{ id: 'lot-a', price, available_capacity: 1 }] : []);
    const result = await tickets.checkout(event({ event_id: 'event-a', organization_id: 'org-a', payment_method: 'PIX', user_id: 'victim' }));
    assert.equal(result.statusCode, 201); assert.equal(JSON.parse(result.body).status, price ? 'PENDING' : 'PAID');
    assert.equal(state.writes.find(x => x.sql.includes('INSERT INTO event_tickets')).params[3], 'member-a'); assert.equal(state.commits, 1); assert.equal(state.releases, 1);
  }
});
test('Scanner refuses canceled tickets and MEMBER role', async () => {
  reset(); let state = transaction(async () => []);
  assert.equal((await tickets.scanTicket(event({ token: 'code' }))).statusCode, 403);
  member.role = 'VOLUNTEER'; state = transaction(async sql => sql.includes('SELECT t.*') ? [{ id: 't', organization_id: 'org-a', status: 'CANCELED' }] : []);
  assert.equal((await tickets.scanTicket(event({ token: 'code' }))).statusCode, 409); assert.equal(state.writes.length, 0);
});
test('Ticket listing ignores email, phone and user_id supplied by another person', async () => {
  reset(); await tickets.myTickets(event({}, { queryStringParameters: { email: 'victim@example.org', phone: '123', user_id: 'victim' } }));
  const query = calls.find(call => call.sql.includes('FROM event_tickets'));
  assert.deepEqual(query.params, ['org-a', 'org-a', 'member-a']);
  assert.equal((await tickets.getTicketPass(event({}, { headers: {}, pathParameters: { id: 't' } }))).statusCode, 401);
});
test('Public prayer listing cannot adopt another identity to read confidential requests', async () => {
  reset(); await prayers.getPrayers(event({}, { headers: {}, queryStringParameters: { organization_id: 'org-a', user_id: 'victim' } }));
  const query = calls.find(call => call.sql.includes('FROM prayers p'));
  assert.ok(query.sql.includes("p.privacy = 'PUBLIC'")); assert.ok(!query.params.includes('victim'));
  assert.equal((await prayers.submitTestimony(event({ testimony_text: 'Alterado' }, { headers: {}, pathParameters: { id: 'victim-prayer' } }))).statusCode, 401);
});
test('Tenant cannot settle SaaS invoices and another tenant invoice is hidden', async () => {
  reset(); member.role = 'ADMIN';
  assert.equal((await financial.paySaasInvoice(event({}, { pathParameters: { id: 'foreign' } }))).statusCode, 404);
  dbQuery = async sql => ({ rows: sql.includes('FROM members') ? [member] : [{ id: 'own' }] });
  assert.equal((await financial.paySaasInvoice(event({}, { pathParameters: { id: 'own' } }))).statusCode, 409);
  assert.ok(!calls.some(call => /UPDATE saas_invoices/.test(call.sql)));
});
test('Kids status uses the authenticated parent, and children cannot be edited anonymously', async () => {
  reset(); await kids.getParentStatus(event({}, { queryStringParameters: { organization_id: 'org-a', phone: 'victim-phone', parent_member_id: 'victim' } }));
  const query = calls.find(call => call.sql.includes('FROM kids_checkins c'));
  assert.deepEqual(query.params, ['org-a', 'member-a']);
  assert.equal((await kids.saveChild(event({}, { headers: {} }))).statusCode, 401);
});
test('Self-registration cannot mutate accounts without a verified Cognito identity', async () => {
  reset(); const result = await members.selfRegister(event({ email: 'victim@example.org' }, { headers: {} }));
  assert.equal(result.statusCode, 401); assert.equal(calls.length, 0);
});
test('Asaas webhook fails closed when its secret is missing or invalid', async () => {
  reset(); const original = process.env.ASAAS_WEBHOOK_SECRET;
  const originalKey = process.env.ASAAS_API_KEY;
  const { resetAsaasConfigCache } = require('../src/services/asaasConfig.ts');
  delete process.env.ASAAS_WEBHOOK_SECRET;
  delete process.env.ASAAS_API_KEY;
  resetAsaasConfigCache();
  assert.equal((await handleAsaasWebhook(event({ event: 'PAYMENT_RECEIVED' }))).statusCode, 503);
  process.env.ASAAS_WEBHOOK_SECRET = 'expected';
  process.env.ASAAS_API_KEY = 'test-key';
  resetAsaasConfigCache();
  assert.equal((await handleAsaasWebhook(event({ event: 'PAYMENT_RECEIVED' }))).statusCode, 401);
  if (original === undefined) delete process.env.ASAAS_WEBHOOK_SECRET; else process.env.ASAAS_WEBHOOK_SECRET = original;
  if (originalKey === undefined) delete process.env.ASAAS_API_KEY; else process.env.ASAAS_API_KEY = originalKey;
  resetAsaasConfigCache();
  assert.equal(calls.length, 0);
});

test('Asaas webhook accepts documented event ids and queues checkout events', async () => {
  reset();
  const originalSecret = process.env.ASAAS_WEBHOOK_SECRET;
  const originalKey = process.env.ASAAS_API_KEY;
  const originalQueue = process.env.SAAS_OPERATIONS_QUEUE_URL;
  const { SQSClient } = require('@aws-sdk/client-sqs');
  const originalSend = SQSClient.prototype.send;
  const { resetAsaasConfigCache } = require('../src/services/asaasConfig.ts');
  process.env.ASAAS_WEBHOOK_SECRET = 'expected';
  process.env.ASAAS_API_KEY = 'test-key';
  process.env.SAAS_OPERATIONS_QUEUE_URL = 'https://sqs.us-east-2.amazonaws.com/123/test';
  resetAsaasConfigCache();
  SQSClient.prototype.send = async () => ({});
  dbQuery = async () => ({ rows: { affectedRows: 1 } });
  try {
    const result = await handleAsaasWebhook(event({
      id: 'evt_37260be8159d4472b4458d3de13efc2d&15370',
      event: 'CHECKOUT_PAID',
      checkout: { id: '6bb2de01-af90-4e2c-a501-c40fe65c6b9c', customer: 'cus_000209233951' }
    }, { headers: { 'asaas-access-token': 'expected' } }));
    assert.equal(result.statusCode, 200);
    const insert = calls.find(call => call.sql.includes('INSERT IGNORE INTO asaas_webhook_events'));
    assert.equal(insert.params[0], 'evt_37260be8159d4472b4458d3de13efc2d&15370');
    assert.equal(insert.params[1], 'CHECKOUT_PAID');
    assert.equal(insert.params[5], 'cus_000209233951');
  } finally {
    SQSClient.prototype.send = originalSend;
    if (originalSecret === undefined) delete process.env.ASAAS_WEBHOOK_SECRET; else process.env.ASAAS_WEBHOOK_SECRET = originalSecret;
    if (originalKey === undefined) delete process.env.ASAAS_API_KEY; else process.env.ASAAS_API_KEY = originalKey;
    if (originalQueue === undefined) delete process.env.SAAS_OPERATIONS_QUEUE_URL; else process.env.SAAS_OPERATIONS_QUEUE_URL = originalQueue;
    resetAsaasConfigCache();
  }
});

test('Gateway credentials are tenant scoped, masked and not copied from shared legacy records', async () => {
  reset(); member.role = 'ADMIN';
  const result = await gateway.updateGatewayConfig(event({ id: 'foreign-gateway', api_key: 'sk_sensitive', ui_settings: { secret_key: 'never-store', recipient_email: 'treasury@example.org' } }));
  assert.equal(result.statusCode, 200);
  const insert = calls.find(call => call.sql.includes('INSERT INTO payment_gateway_settings'));
  assert.equal(insert.params[1], 'org-a');
  assert.notEqual(insert.params[0], 'foreign-gateway');
  assert.equal(JSON.parse(insert.params[2]).secret_key, undefined);
  assert.notEqual(JSON.parse(result.body).config.api_key, 'sk_sensitive');
  reset(); member.role = 'ADMIN';
  assert.equal((await gateway.updateGatewayConfig(event({ organization_id: 'org-b' }))).statusCode, 403);
  assert.ok(!calls.some(call => call.sql.includes('INSERT INTO payment_gateway_settings')));
});
test('Self-registration cannot reactivate an inactive identity or move an existing church membership', async () => {
  reset(); member.status = 'INACTIVE';
  assert.equal((await members.selfRegister(event({ organization_id: 'org-a', name: 'Changed' }))).statusCode, 403);
  assert.ok(!calls.some(call => /^\s*(UPDATE|INSERT)/.test(call.sql)));
  reset(); assert.equal((await members.selfRegister(event({ organization_id: 'org-b' }))).statusCode, 403);
});
test('A leader cannot grant an admin role before Cognito side effects', async () => {
  reset(); member.role = 'LEADER';
  const result = await members.invite(event({ organization_id: 'org-a', email: 'new@example.org', name: 'Pessoa', role: 'ADMIN' }));
  assert.equal(result.statusCode, 403);
  assert.ok(!calls.some(call => call.sql.includes('INSERT INTO members')));
});
test('Secretariat requires both an eligible role and delegated functional permission', async () => {
  reset();
  assert.equal((await secretariat.getDashboard(event({}, { pathParameters: { proxy: 'dashboard' } }))).statusCode, 403);

  reset();
  member.role = 'VOLUNTEER';
  assert.equal((await secretariat.getDashboard(event({}, { pathParameters: { proxy: 'dashboard' } }))).statusCode, 403);

  reset();
  member.role = 'VOLUNTEER';
  member.operational_permissions = JSON.stringify(['secretariat.view']);
  dbQuery = async sql => ({ rows:
    sql.includes('FROM members\n') && !sql.includes('COUNT(*)') ? [member] :
    sql.includes('FROM organizations') ? [{ plan: 'PRO', status: 'ACTIVE' }] :
    sql.includes('FROM tenant_feature_flags') ? [
      { organization_id: 'org-a', feature_key: 'secretariat.module_enabled', is_enabled: 1, environment: 'production' },
      { organization_id: 'org-a', feature_key: 'secretariat.member_registry', is_enabled: 1, environment: 'production' }
    ] :
    sql.includes('total_members') ? [{ total_members: 1, completed_records: 0, incomplete_records: 1 }] :
    sql.includes('pending_requests') ? [{ pending_requests: 0 }] :
    sql.includes('issued_documents') ? [{ issued_documents: 0 }] :
    sql.includes('baptism_records') ? [{ baptism_records: 0 }] : []
  });
  const dashboard = await secretariat.getDashboard(event({}, { pathParameters: { proxy: 'dashboard' } }));
  assert.equal(dashboard.statusCode, 200);
});
test('Secretariat record writes remain tenant scoped and audited', async () => {
  reset();
  member.role = 'ADMIN';
  dbQuery = async sql => ({ rows:
    sql.includes('FROM members\n') && !sql.includes('member_ecclesiastical_records') ? [member] :
    sql.includes('FROM organizations') ? [{ plan: 'PRO', status: 'ACTIVE' }] :
    sql.includes('FROM tenant_feature_flags') ? [
      { organization_id: 'org-a', feature_key: 'secretariat.module_enabled', is_enabled: 1, environment: 'production' },
      { organization_id: 'org-a', feature_key: 'secretariat.member_registry', is_enabled: 1, environment: 'production' }
    ] :
    sql.includes('FROM member_ecclesiastical_records') ? [{ id: 'record-a', organization_id: 'org-a', member_id: 'member-a' }] : []
  });
  const state = transaction(async sql => sql.includes('SELECT m.id, m.campus_id FROM members m')
    ? [{ id: 'member-a', campus_id: 'campus_sede' }]
    : { affectedRows: 1 });
  const result = await secretariat.upsertRecord(event({
    organization_id: 'org-a',
    membership_status: 'ACTIVE',
    admission_type: 'BAPTISM',
    admission_date: '2026-10-27',
    baptism_date: '2026-10-27',
    registry_number: 'FH-0001'
  }, { pathParameters: { proxy: 'members/member-a/record' } }));
  assert.equal(result.statusCode, 200);
  assert.equal(state.commits, 1);
  assert.ok(state.writes.some(write => write.sql.includes('INSERT INTO member_ecclesiastical_records') && write.params.includes('org-a')));
  assert.ok(state.writes.some(write => write.sql.includes('UPDATE members') && write.params.includes('org-a')));
  assert.ok(calls.some(call => call.sql.includes('INSERT INTO security_audit_logs')));

  reset();
  member.role = 'ADMIN';
  const denied = await secretariat.upsertRecord(event({ organization_id: 'org-b' }, { pathParameters: { proxy: 'members/member-a/record' } }));
  assert.equal(denied.statusCode, 403);
});
test('Private route declarations include the Cognito authorizer', () => {
  const config = fs.readFileSync(require('node:path').join(__dirname, '../serverless.yml'), 'utf8');
  for (const name of ['listMembers', 'updateMember', 'selfRegisterMember', 'secretariatHandler', 'getPdvOrders', 'myTickets', 'getTicketPass', 'scanTicket', 'getPagarmeSettings', 'kidsHandler', 'financialHandler']) {
    const block = config.split('\n  ' + name + ':')[1].split(/\n  \w+:/)[0];
    const events = block.split('- httpApi:').slice(1);
    assert.ok(events.length);
    for (const event of events) assert.ok(event.includes('authorizer: cognitoAuthorizer'), name);
  }
});

test('A private request cannot select another campus through headers, query or body', async () => {
  for (const request of [event({ campus_id: 'foreign-campus' }), event({}, { queryStringParameters: { campus_id: 'foreign-campus' } }), event({}, { headers: { Authorization: 'Bearer ' + token, 'x-campus-id': 'foreign-campus' } })]) {
    reset(); assert.equal((await auth.requireAuth(request)).errorResponse.statusCode, 403);
  }
});
test('Unconfigured payment provider cannot return a simulated subscription', async () => {
  const { AsaasService } = require('../src/services/asaasService.ts');
  await assert.rejects(AsaasService.createSubscription({ customer: 'customer', billingType: 'PIX', value: 100, nextDueDate: '2026-11-01', cycle: 'MONTHLY' }));
});

test('Donor receipt creates only a pending contribution attributed to the authenticated member', async () => {
  reset();
  const result = await financial.createFinancialTransaction(event({ organization_id: 'org-a', type: 'INCOME', category: 'Oferta', description: 'Comprovante', amount: 25, status: 'PENDING', origin_module: 'TITHES', member_id: 'victim', member_name: 'Victim' }));
  assert.equal(result.statusCode, 201);
  const insert = calls.find(call => call.sql.includes('INSERT INTO church_financial_transactions'));
  assert.equal(insert.params[8], 'PENDING'); assert.equal(insert.params[9], 'member-a'); assert.equal(insert.params[10], 'Membro');
  reset(); assert.equal((await financial.createFinancialTransaction(event({ organization_id: 'org-a', type: 'INCOME', category: 'Oferta', description: 'Manipulado', amount: 25, status: 'PAID', origin_module: 'TITHES' }))).statusCode, 403);
  assert.ok(!calls.some(call => call.sql.includes('INSERT INTO church_financial_transactions')));
});
