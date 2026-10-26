require('dotenv').config();

const REQUIRED_EVENTS = [
  'CHECKOUT_CREATED',
  'CHECKOUT_PAID',
  'CHECKOUT_CANCELED',
  'CHECKOUT_EXPIRED',
  'PAYMENT_CREATED',
  'PAYMENT_UPDATED',
  'PAYMENT_CONFIRMED',
  'PAYMENT_RECEIVED',
  'PAYMENT_OVERDUE',
  'PAYMENT_RESTORED',
  'PAYMENT_REFUNDED',
  'PAYMENT_PARTIALLY_REFUNDED',
  'PAYMENT_REFUND_IN_PROGRESS',
  'PAYMENT_CHARGEBACK_REQUESTED',
  'PAYMENT_CHARGEBACK_DISPUTE',
  'PAYMENT_DELETED',
  'SUBSCRIPTION_CREATED',
  'SUBSCRIPTION_UPDATED',
  'SUBSCRIPTION_INACTIVATED',
  'SUBSCRIPTION_DELETED'
];

async function asaas(path, options = {}) {
  const apiKey = process.env.ASAAS_API_KEY;
  if (!apiKey) throw new Error('ASAAS_API_KEY_REQUIRED_FOR_ADMIN_SCRIPT');
  const environment = process.env.ASAAS_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
  const baseUrl = environment === 'production' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3';
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'faith-hub-webhook-sync/1.0', access_token: apiKey }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`ASAAS_WEBHOOK_SYNC_FAILED:${response.status}`);
  return body;
}

async function main() {
  const webhookUrl = process.env.ASAAS_WEBHOOK_URL ||
    'https://usl72lj2m5.execute-api.us-east-2.amazonaws.com/webhooks/asaas';
  const list = await asaas('/webhooks');
  const current = (list.data || []).find(item => item.url === webhookUrl);
  if (!current) throw new Error('FAITH_HUB_ASAAS_WEBHOOK_NOT_FOUND');
  const events = [...new Set([...(current.events || []), ...REQUIRED_EVENTS])].sort();
  await asaas(`/webhooks/${encodeURIComponent(current.id)}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: current.name || 'Faith-Hub SaaS Billing',
      url: webhookUrl,
      enabled: true,
      interrupted: false,
      apiVersion: 3,
      sendType: 'SEQUENTIALLY',
      events
    })
  });
  const verified = await asaas('/webhooks');
  const saved = (verified.data || []).find(item => item.id === current.id);
  const missing = REQUIRED_EVENTS.filter(event => !saved?.events?.includes(event));
  if (missing.length) throw new Error(`ASAAS_WEBHOOK_EVENTS_MISSING:${missing.join(',')}`);
  console.log(JSON.stringify({ webhookId: current.id, enabled: saved.enabled, interrupted: saved.interrupted, eventCount: saved.events.length, synchronized: true }));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
