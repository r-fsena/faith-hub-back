// Serviço de Integração com a API Asaas v3

const ASAAS_API_KEY = process.env.ASAAS_API_KEY || '';
const ASAAS_ENVIRONMENT = process.env.ASAAS_ENVIRONMENT || 'sandbox'; // 'sandbox' ou 'production'
const ASAAS_API_URL = ASAAS_ENVIRONMENT === 'production' 
  ? 'https://api.asaas.com/v3' 
  : 'https://sandbox.asaas.com/api/v3';

export interface AsaasCustomerInput {
  name: string;
  email: string;
  cpfCnpj?: string;
  phone?: string;
  mobilePhone?: string;
  postalCode?: string;
  address?: string;
  addressNumber?: string;
  complement?: string;
  province?: string;
}

export interface AsaasSubscriptionInput {
  customer: string;
  billingType: 'BOLETO' | 'CREDIT_CARD' | 'PIX' | 'UNDEFINED';
  value: number;
  nextDueDate: string; // YYYY-MM-DD
  cycle: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUALLY' | 'YEARLY';
  description?: string;
  creditCard?: {
    holderName: string;
    number: string;
    expiryMonth: string;
    expiryYear: string;
    ccv: string;
  };
  creditCardHolderInfo?: {
    name: string;
    email: string;
    cpfCnpj: string;
    postalCode: string;
    addressNumber: string;
    phone: string;
  };
}

export class AsaasService {
  private static async request(path: string, body?: unknown): Promise<any> {
    if (!ASAAS_API_KEY) throw new Error('Provedor de pagamentos não configurado');
    const response = await fetch(ASAAS_API_URL + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', access_token: ASAAS_API_KEY },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    const data: any = await response.json();
    if (!response.ok) throw new Error('Provedor de pagamentos recusou a operação');
    return data;
  }
  static async createCustomer(data: AsaasCustomerInput) {
    const result = await this.request('/customers?email=' + encodeURIComponent(data.email));
    if (result.data?.length) return result.data[0];
    const customer = await this.request('/customers', {
      ...data, cpfCnpj: data.cpfCnpj?.replace(/\D/g, ''),
      mobilePhone: (data.mobilePhone || data.phone)?.replace(/\D/g, ''), notificationDisabled: false
    });
    if (!customer.id) throw new Error('Resposta inválida do provedor');
    return customer;
  }
  static async createSubscription(data: AsaasSubscriptionInput) {
    const subscription = await this.request('/subscriptions', data);
    if (!subscription.id) throw new Error('Resposta inválida do provedor');
    return subscription;
  }
  static async getPaymentQrCode(paymentId: string) {
    return this.request('/payments/' + encodeURIComponent(paymentId) + '/pixQrCode');
  }
}
