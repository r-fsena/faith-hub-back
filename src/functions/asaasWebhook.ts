// Webhook Receiver para o Asaas v3
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';
import { ProvisioningService } from '../services/provisioningService';

export const handleAsaasWebhook = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const webhookEvent = body.event;
    const payment = body.payment || {};
    const subscriptionId = payment.subscription || body.subscription?.id;
    const customerId = payment.customer || body.customer?.id;

    console.log(`🔔 Webhook Asaas Recebido: ${webhookEvent}`, {
      subscriptionId,
      customerId,
      paymentId: payment.id,
      value: payment.value
    });

    // 1. Pagamento Confirmado / Recebido (Liquidação)
    if (webhookEvent === 'PAYMENT_CONFIRMED' || webhookEvent === 'PAYMENT_RECEIVED') {
      // Localiza a proposta pelo subscription_id ou customer_id
      let proposalId: string | null = null;
      if (subscriptionId) {
        const { rows } = await query(`SELECT id FROM saas_proposals WHERE asaas_subscription_id = ? LIMIT 1`, [subscriptionId]);
        if (rows.length > 0) proposalId = rows[0].id;
      }

      if (!proposalId && customerId) {
        const { rows } = await query(`SELECT id FROM saas_proposals WHERE asaas_customer_id = ? AND status != 'PAID' ORDER BY created_at DESC LIMIT 1`, [customerId]);
        if (rows.length > 0) proposalId = rows[0].id;
      }

      if (proposalId) {
        console.log(`🚀 Disparando provisionamento automático para a proposta: ${proposalId}`);
        await ProvisioningService.provisionFromProposal(proposalId);
      } else {
        console.log('ℹ️ Pagamento recebido para assinatura avulsa ou já provisionada.');
      }

      // Atualiza status da assinatura em saas_subscriptions
      if (subscriptionId) {
        await query(`
          UPDATE saas_subscriptions 
          SET status = 'ACTIVE', updated_at = NOW() 
          WHERE id = ? OR customer_id = ?
        `, [subscriptionId, customerId]);
      }
    }

    // 2. Pagamento Atrasado / Inadimplência
    else if (webhookEvent === 'PAYMENT_OVERDUE') {
      console.warn(`⚠️ Assinatura com pagamento em atraso: ${subscriptionId || customerId}`);
      if (subscriptionId || customerId) {
        await query(`
          UPDATE saas_subscriptions 
          SET status = 'OVERDUE', updated_at = NOW() 
          WHERE id = ? OR customer_id = ?
        `, [subscriptionId, customerId]);
      }
    }

    // 3. Pagamento Regularizado após atraso
    else if (webhookEvent === 'PAYMENT_RESTORED' || webhookEvent === 'PAYMENT_UPDATED') {
      if (subscriptionId || customerId) {
        await query(`
          UPDATE saas_subscriptions 
          SET status = 'ACTIVE', updated_at = NOW() 
          WHERE id = ? OR customer_id = ?
        `, [subscriptionId, customerId]);
      }
    }

    return apiResponse(200, { received: true, event: webhookEvent });
  } catch (error: any) {
    console.error('Erro no processamento do Webhook Asaas:', error);
    return apiResponse(500, { message: 'Erro interno ao processar webhook', error: error.message });
  }
};
