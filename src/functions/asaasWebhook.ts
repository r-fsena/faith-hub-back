import crypto from 'crypto';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { apiResponse, query } from '../db';
import { getAsaasConfig } from '../services/asaasConfig';
import { enqueueAsaasEvent } from '../services/saasQueueService';

function secureEqual(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const left = Buffer.from(received, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function safeProviderId(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:&-]{1,100}$/.test(value)) return null;
  return value;
}

export const handleAsaasWebhook = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    let config;
    try {
      config = await getAsaasConfig();
    } catch {
      return apiResponse(503, { message: 'Webhook não configurado' });
    }
    const receivedToken = Object.entries(event.headers || {}).find(
      ([key]) => key.toLowerCase() === 'asaas-access-token'
    )?.[1];
    if (!secureEqual(receivedToken, config.webhookSecret)) {
      console.warn('Webhook Asaas rejeitado por token inválido', { hasToken: Boolean(receivedToken) });
      return apiResponse(401, { message: 'Não autorizado' });
    }

    let body: any;
    try {
      const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body || '', 'base64').toString('utf8')
        : (event.body || '{}');
      body = JSON.parse(rawBody);
    } catch {
      return apiResponse(400, { message: 'Payload inválido' });
    }

    const eventId = safeProviderId(body.id);
    const eventType = typeof body.event === 'string' && /^[A-Z_]{3,80}$/.test(body.event)
      ? body.event
      : null;
    if (!eventId || !eventType) return apiResponse(400, { message: 'Evento Asaas inválido' });

    const paymentId = safeProviderId(body.payment?.id);
    const subscriptionId = safeProviderId(body.payment?.subscription || body.subscription?.id);
    const checkoutId = safeProviderId(body.checkout?.id);
    const customerId = safeProviderId(body.payment?.customer || body.subscription?.customer || body.checkout?.customer);
    if (eventType.startsWith('PAYMENT_') && !paymentId) {
      return apiResponse(400, { message: 'Evento de pagamento sem identificador' });
    }
    if (eventType.startsWith('SUBSCRIPTION_') && !subscriptionId) {
      return apiResponse(400, { message: 'Evento de assinatura sem identificador' });
    }

    const payloadHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const insert = await query(`INSERT IGNORE INTO asaas_webhook_events
      (id, event_type, payment_id, subscription_id, checkout_id, customer_id, payload_hash, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'RECEIVED')`, [
      eventId, eventType, paymentId, subscriptionId, checkoutId, customerId, payloadHash
    ]);
    const inserted = Number((insert.rows as any).affectedRows || 0) === 1;
    if (!inserted) {
      const { rows } = await query('SELECT status FROM asaas_webhook_events WHERE id = ? LIMIT 1', [eventId]);
      if (rows[0]?.status === 'PROCESSED') {
        return apiResponse(200, { received: true, duplicate: true });
      }
    }

    await enqueueAsaasEvent(eventId);
    await query(`UPDATE asaas_webhook_events SET status = 'QUEUED', last_error = NULL, updated_at = NOW()
      WHERE id = ? AND status != 'PROCESSED'`, [eventId]);
    return apiResponse(200, { received: true, event_id: eventId });
  } catch (error: any) {
    console.error('Falha ao persistir webhook Asaas', { error: error?.message || 'UNKNOWN' });
    return apiResponse(500, { message: 'Falha temporária ao receber evento' });
  }
};
