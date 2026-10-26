require('dotenv').config();
const {
  SecretsManagerClient,
  CreateSecretCommand,
  DescribeSecretCommand,
  PutSecretValueCommand
} = require('@aws-sdk/client-secrets-manager');

async function main() {
  const apiKey = process.env.ASAAS_API_KEY;
  const webhookSecret = process.env.ASAAS_WEBHOOK_SECRET;
  const environment = process.env.ASAAS_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
  if (!apiKey || !webhookSecret) throw new Error('ASAAS_LOCAL_CONFIGURATION_REQUIRED');

  const name = 'faith-hub/asaas/platform';
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-2' });
  const secretString = JSON.stringify({ apiKey, webhookSecret, environment });
  let arn;
  try {
    const current = await client.send(new DescribeSecretCommand({ SecretId: name }));
    arn = current.ARN;
    await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: secretString }));
  } catch (error) {
    if (error?.name !== 'ResourceNotFoundException') throw error;
    const created = await client.send(new CreateSecretCommand({
      Name: name,
      Description: 'Credenciais da integração SaaS Faith-Hub com Asaas',
      SecretString: secretString,
      Tags: [
        { Key: 'Application', Value: 'Faith-Hub' },
        { Key: 'Purpose', Value: 'Asaas-SaaS-Billing' }
      ]
    }));
    arn = created.ARN;
  }
  if (!arn) throw new Error('ASAAS_SECRET_ARN_NOT_RETURNED');
  console.log(JSON.stringify({ secretArn: arn, environment, synchronized: true }));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
