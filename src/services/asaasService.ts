import { getAsaasConfig } from './asaasConfig';

export interface HostedCheckoutInput {
  externalReference: string;
  billingTypes: Array<'PIX' | 'CREDIT_CARD'>;
  name: string;
  description: string;
  value: number;
  cycle: 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUALLY' | 'YEARLY';
  nextDueDate: string;
  customerData: { name: string; email: string; cpfCnpj: string; phone?: string };
  successUrl: string;
  cancelUrl: string;
  expiredUrl: string;
}

export interface AsaasPayment {
  id: string;
  customer?: string;
  subscription?: string;
  externalReference?: string;
  status?: string;
  value?: number;
  netValue?: number;
  dueDate?: string;
  paymentDate?: string;
  clientPaymentDate?: string;
  billingType?: string;
  invoiceUrl?: string;
  bankSlipUrl?: string;
}

export interface AsaasSubscription {
  id: string;
  customer?: string;
  externalReference?: string;
  status?: string;
  value?: number;
  cycle?: string;
  billingType?: string;
  nextDueDate?: string;
}

export class AsaasService {
  private static async request<T>(path: string, options: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown } = {}): Promise<T> {
    const config = await getAsaasConfig();
    const baseUrl = config.environment === 'production'
      ? 'https://api.asaas.com/v3'
      : 'https://api-sandbox.asaas.com/v3';
    const response = await fetch(baseUrl + path, {
      method: options.method || (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'faith-hub-backend/1.0',
        access_token: config.apiKey
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(15000)
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`ASAAS_REQUEST_FAILED:${response.status}`);
      (error as any).providerStatus = response.status;
      (error as any).providerErrors = Array.isArray(data?.errors)
        ? data.errors.slice(0, 5).map((item: any) => ({
          code: String(item?.code || 'UNKNOWN').slice(0, 80),
          description: String(item?.description || '').slice(0, 300)
        }))
        : [];
      throw error;
    }
    return data as T;
  }

  static async createHostedRecurringCheckout(input: HostedCheckoutInput) {
    if (input.billingTypes.length !== 1 || input.billingTypes[0] !== 'CREDIT_CARD') {
      throw new Error('ASAAS_RECURRENT_CHECKOUT_REQUIRES_CREDIT_CARD');
    }
    if (!Number.isFinite(input.value) || input.value < 5) {
      throw new Error('ASAAS_CHECKOUT_MINIMUM_VALUE_5_BRL');
    }
    const checkout = await this.request<any>('/checkouts', {
      body: {
        billingTypes: input.billingTypes,
        chargeTypes: ['RECURRENT'],
        minutesToExpire: 60,
        externalReference: input.externalReference,
        items: [{
          name: input.name.slice(0, 30),
          description: input.description.slice(0, 150),
          imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4WQAAAABJRU5ErkJggg==',
          quantity: 1,
          value: input.value
        }],
        subscription: { cycle: input.cycle, nextDueDate: input.nextDueDate },
        customerData: {
          name: input.customerData.name,
          email: input.customerData.email,
          cpfCnpj: input.customerData.cpfCnpj.replace(/\D/g, ''),
          phone: input.customerData.phone?.replace(/\D/g, '') || undefined
        },
        callback: {
          successUrl: input.successUrl,
          cancelUrl: input.cancelUrl,
          expiredUrl: input.expiredUrl
        }
      }
    });
    if (!checkout.id) throw new Error('ASAAS_CHECKOUT_INVALID_RESPONSE');
    const config = await getAsaasConfig();
    const host = config.environment === 'production' ? 'https://asaas.com' : 'https://sandbox.asaas.com';
    return {
      ...checkout,
      url: checkout.link || `${host}/checkoutSession/show/${encodeURIComponent(checkout.id)}`,
      environment: config.environment
    };
  }

  static getPayment(paymentId: string): Promise<AsaasPayment> {
    return this.request(`/payments/${encodeURIComponent(paymentId)}`);
  }

  static getSubscription(subscriptionId: string): Promise<AsaasSubscription> {
    return this.request(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }

  static listSubscriptionPayments(subscriptionId: string): Promise<{ data: AsaasPayment[]; hasMore?: boolean }> {
    return this.request(`/subscriptions/${encodeURIComponent(subscriptionId)}/payments?limit=100`);
  }

  /** @deprecated Direct subscriptions could expose card data to Faith-Hub. */
  static createSubscription(): Promise<never> {
    return Promise.reject(new Error('DIRECT_SUBSCRIPTION_DISABLED_USE_HOSTED_CHECKOUT'));
  }
}
