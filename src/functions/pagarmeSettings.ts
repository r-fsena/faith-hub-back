import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';

const DEFAULT_GATEWAY_CONFIG = {
  id: 'default_gateway',
  environment: 'test',
  api_key: '',
  encryption_key: '',
  recipient_id: '',
  bank_code: '001',
  bank_name: 'Banco do Brasil S.A.',
  agency: '',
  account: '',
  account_digit: '',
  document_number: '',
  legal_name: '',
  pix_key_type: 'CNPJ',
  pix_key: '',
  auto_split_enabled: false,
  fee_percentage: 0.00
};

// GET /pagarme-settings
export const getGatewayConfig = async (_event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const { rows } = await query(`SELECT * FROM payment_gateway_settings ORDER BY updated_at DESC LIMIT 1`);
    if (rows.length === 0) {
      return apiResponse(200, DEFAULT_GATEWAY_CONFIG);
    }

    const item = rows[0];
    return apiResponse(200, {
      ...DEFAULT_GATEWAY_CONFIG,
      ...item,
      auto_split_enabled: Boolean(item.auto_split_enabled),
      fee_percentage: Number(item.fee_percentage) || 0
    });
  } catch (error: any) {
    console.error('Erro ao buscar pagarme-settings:', error);
    return apiResponse(200, DEFAULT_GATEWAY_CONFIG);
  }
};

// POST /pagarme-settings
export const updateGatewayConfig = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const config = { ...DEFAULT_GATEWAY_CONFIG, ...body };

    const sql = `
      INSERT INTO payment_gateway_settings (
        id, environment, api_key, encryption_key, recipient_id,
        bank_code, bank_name, agency, account, account_digit,
        document_number, legal_name, pix_key_type, pix_key,
        auto_split_enabled, fee_percentage
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        environment = VALUES(environment),
        api_key = VALUES(api_key),
        encryption_key = VALUES(encryption_key),
        recipient_id = VALUES(recipient_id),
        bank_code = VALUES(bank_code),
        bank_name = VALUES(bank_name),
        agency = VALUES(agency),
        account = VALUES(account),
        account_digit = VALUES(account_digit),
        document_number = VALUES(document_number),
        legal_name = VALUES(legal_name),
        pix_key_type = VALUES(pix_key_type),
        pix_key = VALUES(pix_key),
        auto_split_enabled = VALUES(auto_split_enabled),
        fee_percentage = VALUES(fee_percentage),
        updated_at = NOW()
    `;

    const params = [
      config.id || 'default_gateway',
      config.environment || 'test',
      config.api_key || '',
      config.encryption_key || '',
      config.recipient_id || '',
      config.bank_code || '001',
      config.bank_name || 'Banco do Brasil S.A.',
      config.agency || '',
      config.account || '',
      config.account_digit || '',
      config.document_number || '',
      config.legal_name || '',
      config.pix_key_type || 'CNPJ',
      config.pix_key || '',
      config.auto_split_enabled ? 1 : 0,
      config.fee_percentage || 0.00
    ];

    await query(sql, params);

    return apiResponse(200, {
      message: 'Configurações do Gateway salvas com sucesso!',
      config
    });
  } catch (error: any) {
    console.error('Erro ao salvar pagarme-settings:', error);
    return apiResponse(500, { message: 'Erro ao salvar configurações do Gateway', error: error.message });
  }
};
