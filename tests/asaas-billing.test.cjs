process.env.AWS_EC2_METADATA_DISABLED = 'true';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => module._compile(
  ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText,
  filename
);

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

test('hosted recurrence uses the sandbox endpoint and never sends card credentials', async () => {
  process.env.ASAAS_API_KEY = 'sandbox-key';
  process.env.ASAAS_WEBHOOK_SECRET = 'webhook-secret';
  process.env.ASAAS_ENVIRONMENT = 'sandbox';
  delete process.env.ASAAS_SECRET_ARN;
  const { resetAsaasConfigCache } = require('../src/services/asaasConfig.ts');
  const { AsaasService } = require('../src/services/asaasService.ts');
  resetAsaasConfigCache();
  let request;
  global.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ id: 'chk_test' }) };
  };

  const result = await AsaasService.createHostedRecurringCheckout({
    externalReference: 'faithhub:proposal:00000000-0000-4000-8000-000000000001',
    billingTypes: ['CREDIT_CARD'],
    name: 'Faith-Hub PRO', description: 'Assinatura', value: 297,
    cycle: 'MONTHLY', nextDueDate: '2026-11-26',
    successUrl: 'https://studio.faithhubs.com/?proposta=token&retorno=sucesso',
    cancelUrl: 'https://studio.faithhubs.com/?proposta=token&retorno=cancelado',
    expiredUrl: 'https://studio.faithhubs.com/?proposta=token&retorno=expirado'
  });

  assert.equal(request.url, 'https://api-sandbox.asaas.com/v3/checkouts');
  assert.deepEqual(request.body.chargeTypes, ['RECURRENT']);
  assert.deepEqual(request.body.billingTypes, ['CREDIT_CARD']);
  assert.equal(request.body.customerData, undefined);
  assert.equal(request.body.items[0].imageBase64, undefined);
  assert.equal(request.body.callback.cancelUrl.includes('cancelado'), true);
  assert.equal(request.body.callback.autoRedirect, undefined);
  assert.equal(JSON.stringify(request.body).match(/creditCard|ccv|cardNumber/), null);
  assert.equal(result.url, 'https://sandbox.asaas.com/checkoutSession/show?id=chk_test');
});

test('hosted recurrence rejects PIX and values below the provider minimum before any request', async () => {
  const { AsaasService } = require('../src/services/asaasService.ts');
  const base = {
    externalReference: 'faithhub:proposal:00000000-0000-4000-8000-000000000001',
    name: 'Faith-Hub PRO', description: 'Assinatura', value: 5,
    cycle: 'MONTHLY', nextDueDate: '2026-11-26',
    successUrl: 'https://studio.faithhubs.com/sucesso',
    cancelUrl: 'https://studio.faithhubs.com/cancelado',
    expiredUrl: 'https://studio.faithhubs.com/expirado'
  };
  await assert.rejects(AsaasService.createHostedRecurringCheckout({ ...base, billingTypes: ['PIX'] }), /REQUIRES_CREDIT_CARD/);
  await assert.rejects(AsaasService.createHostedRecurringCheckout({ ...base, billingTypes: ['CREDIT_CARD'], value: 4.99 }), /MINIMUM_VALUE/);
});

test('deployment and Studio contracts contain no fake or raw-card payment path', () => {
  const root = path.join(__dirname, '..');
  const serverless = fs.readFileSync(path.join(root, 'serverless.yml'), 'utf8');
  const proposals = fs.readFileSync(path.join(root, 'src/functions/proposals.ts'), 'utf8');
  const studio = fs.readFileSync(path.join(root, '../faith-hub-web/src/modules/ProposalPublicView.tsx'), 'utf8');
  assert.ok(!serverless.includes('ASAAS_API_KEY:'));
  assert.ok(!serverless.includes('ASAAS_WEBHOOK_SECRET:'));
  assert.ok(!serverless.includes('simulate-payment'));
  assert.ok(proposals.includes('Dados de cartão devem ser informados somente no checkout seguro do Asaas.'));
  assert.ok(!studio.includes('cardCvv'));
  assert.ok(!studio.includes('api.qrserver.com'));
  assert.ok(!studio.includes('Modo Simulação'));
});

test('production checkout flag fails closed and releases only an allowlisted proposal', async () => {
  const allowed = '00000000-0000-4000-8000-000000000001';
  const denied = '00000000-0000-4000-8000-000000000002';
  let enabled = true;
  const dbPath = require.resolve('../src/db/index.ts');
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      query: async sql => ({ rows: sql.includes('FROM organizations') ? [{ plan: 'PRO' }] : [{
        organization_id: 'global', feature_key: 'system.saas_billing_checkout', is_enabled: enabled ? 1 : 0,
        environment: 'all', campus_id: null,
        config_payload: JSON.stringify({ mode: 'allowlist', allowedProposalIds: [allowed] })
      }] })
    }
  };
  delete require.cache[require.resolve('../src/services/featureFlagService.ts')];
  const { evaluateSaasCheckoutAccess } = require('../src/services/featureFlagService.ts');
  assert.equal(await evaluateSaasCheckoutAccess(allowed), true);
  assert.equal(await evaluateSaasCheckoutAccess(denied), false);
  assert.equal(await evaluateSaasCheckoutAccess('invalid'), false);
  enabled = false;
  assert.equal(await evaluateSaasCheckoutAccess(allowed), false);
});
