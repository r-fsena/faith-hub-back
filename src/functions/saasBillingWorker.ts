import { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { processAsaasEvent } from '../services/asaasReconciliationService';

export async function handleSaasBillingQueue(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body || '{}');
      if (message.type !== 'ASAAS_EVENT' || !message.eventId) throw new Error('INVALID_SAAS_QUEUE_MESSAGE');
      await processAsaasEvent(String(message.eventId));
    } catch (error) {
      console.error('Falha ao processar item da fila SaaS', { messageId: record.messageId, error });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
