import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-east-2' });

export async function enqueueAsaasEvent(eventId: string): Promise<void> {
  const queueUrl = process.env.SAAS_OPERATIONS_QUEUE_URL;
  if (!queueUrl) throw new Error('SAAS_OPERATIONS_QUEUE_URL_REQUIRED');
  await sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({ type: 'ASAAS_EVENT', eventId })
  }));
}
