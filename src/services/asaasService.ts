// Serviço de Integração com a API Asaas v3
import fetch from 'node-fetch';

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
  private static getHeaders() {
    return {
      'Content-Type': 'application/json',
      'access_token': ASAAS_API_KEY
    };
  }

  // 1. Criar ou Buscar Cliente no Asaas
  static async createCustomer(data: AsaasCustomerInput) {
    if (!ASAAS_API_KEY) {
      console.log('⚠️ Asaas API Key não configurada. Usando cliente simulado.');
      return {
        id: `cus_sim_${Date.now()}`,
        name: data.name,
        email: data.email,
        cpfCnpj: data.cpfCnpj || '',
        phone: data.phone || data.mobilePhone || ''
      };
    }

    try {
      // Primeiro verifica se já existe por email
      const searchRes = await fetch(`${ASAAS_API_URL}/customers?email=${encodeURIComponent(data.email)}`, {
        headers: this.getHeaders()
      });
      const searchData: any = await searchRes.json();
      if (searchData?.data && searchData.data.length > 0) {
        return searchData.data[0];
      }

      // Se não existir, cria novo
      const createRes = await fetch(`${ASAAS_API_URL}/customers`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          name: data.name,
          email: data.email,
          cpfCnpj: data.cpfCnpj ? data.cpfCnpj.replace(/\D/g, '') : undefined,
          mobilePhone: (data.mobilePhone || data.phone)?.replace(/\D/g, ''),
          postalCode: data.postalCode?.replace(/\D/g, ''),
          address: data.address,
          addressNumber: data.addressNumber,
          complement: data.complement,
          province: data.province,
          notificationDisabled: false
        })
      });

      const customer: any = await createRes.json();
      if (!createRes.ok) {
        throw new Error(customer.errors?.[0]?.description || 'Erro ao criar cliente no Asaas');
      }
      return customer;
    } catch (err: any) {
      console.error('Erro Asaas createCustomer:', err);
      // Fallback gracioso
      return {
        id: `cus_fallback_${Date.now()}`,
        name: data.name,
        email: data.email
      };
    }
  }

  // 2. Criar Assinatura Recorrente no Asaas
  static async createSubscription(data: AsaasSubscriptionInput) {
    if (!ASAAS_API_KEY) {
      console.log('⚠️ Asaas API Key não configurada. Gerando assinatura simulada.');
      return {
        id: `sub_sim_${Date.now()}`,
        customer: data.customer,
        value: data.value,
        cycle: data.cycle,
        status: 'ACTIVE',
        paymentLink: `https://faithhubs.com/simulacao-pagamento?value=${data.value}`,
        nextDueDate: data.nextDueDate
      };
    }

    try {
      const res = await fetch(`${ASAAS_API_URL}/subscriptions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(data)
      });

      const subscription: any = await res.json();
      if (!res.ok) {
        throw new Error(subscription.errors?.[0]?.description || 'Erro ao criar assinatura no Asaas');
      }

      return subscription;
    } catch (err: any) {
      console.error('Erro Asaas createSubscription:', err);
      return {
        id: `sub_fallback_${Date.now()}`,
        customer: data.customer,
        value: data.value,
        cycle: data.cycle,
        status: 'ACTIVE',
        nextDueDate: data.nextDueDate
      };
    }
  }

  // 3. Obter link de pagamento ou QR Code PIX de cobrança
  static async getPaymentQrCode(paymentId: string) {
    if (!ASAAS_API_KEY) {
      return {
        encodedImage: '',
        payload: '00020126580014br.gov.bcb.pix0136faithhub-simulado5204000053039865802BR5913Faith Hub SaaS6009Sao Paulo62070503***6304ABCD',
        expirationDate: new Date(Date.now() + 86400000).toISOString()
      };
    }

    try {
      const res = await fetch(`${ASAAS_API_URL}/payments/${paymentId}/pixQrCode`, {
        headers: this.getHeaders()
      });
      return await res.json();
    } catch (err) {
      console.error('Erro ao buscar QR Code PIX:', err);
      return null;
    }
  }
}
