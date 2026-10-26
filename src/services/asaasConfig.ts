import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export type AsaasEnvironment = 'sandbox' | 'production';

export interface AsaasSecretConfig {
  apiKey: string;
  webhookSecret: string;
  environment: AsaasEnvironment;
}

let cachedConfig: Promise<AsaasSecretConfig> | undefined;
const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-2' });

function validateConfig(value: Partial<AsaasSecretConfig>): AsaasSecretConfig {
  const environment = value.environment === 'production' ? 'production' : 'sandbox';
  if (!value.apiKey || !value.webhookSecret) throw new Error('ASAAS_SECRET_INCOMPLETE');
  return { apiKey: value.apiKey, webhookSecret: value.webhookSecret, environment };
}

async function loadConfig(): Promise<AsaasSecretConfig> {
  const secretArn = process.env.ASAAS_SECRET_ARN;
  if (secretArn) {
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!response.SecretString) throw new Error('ASAAS_SECRET_EMPTY');
    try {
      return validateConfig(JSON.parse(response.SecretString));
    } catch (error) {
      if (error instanceof Error && error.message === 'ASAAS_SECRET_INCOMPLETE') throw error;
      throw new Error('ASAAS_SECRET_INVALID_JSON');
    }
  }

  if (process.env.AWS_LAMBDA_FUNCTION_NAME) throw new Error('ASAAS_SECRET_ARN_REQUIRED');
  return validateConfig({
    apiKey: process.env.ASAAS_API_KEY,
    webhookSecret: process.env.ASAAS_WEBHOOK_SECRET,
    environment: process.env.ASAAS_ENVIRONMENT as AsaasEnvironment
  });
}

export function getAsaasConfig(): Promise<AsaasSecretConfig> {
  if (!cachedConfig) {
    cachedConfig = loadConfig().catch(error => {
      cachedConfig = undefined;
      throw error;
    });
  }
  return cachedConfig;
}

export function resetAsaasConfigCache(): void {
  cachedConfig = undefined;
}
