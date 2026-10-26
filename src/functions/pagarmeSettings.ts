import { v5 as uuidv5 } from 'uuid';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant, maskSecret } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';

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
export const getGatewayConfig = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) {
      return auth.errorResponse;
    }

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN', 'TREASURER']);
    if (!roleCheck.allowed) {
      return roleCheck.errorResponse!;
    }

    const tenantCheck = enforceTenant(auth.user, event.queryStringParameters?.organization_id || event.headers?.['x-organization-id']);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const { rows } = await query(`SELECT * FROM payment_gateway_settings WHERE organization_id = ? LIMIT 1`, [tenantCheck.effectiveOrgId]);
    if (rows.length === 0) {
      return apiResponse(200, DEFAULT_GATEWAY_CONFIG);
    }

    const item = rows[0];

    // Retorna as chaves de API mascaradas para segurança contra inspeção indevida
    return apiResponse(200, {
      ...DEFAULT_GATEWAY_CONFIG,
      ...item,
      api_key: maskSecret(item.api_key),
      encryption_key: maskSecret(item.encryption_key),
      auto_split_enabled: Boolean(item.auto_split_enabled),
      fee_percentage: Number(item.fee_percentage) || 0
    });
  } catch (error: any) {
    console.error('Erro ao buscar pagarme-settings:', error);
    return apiResponse(500, { message: 'Erro ao buscar configurações do Gateway' });
  }
};

// POST /pagarme-settings
export const updateGatewayConfig = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) {
      return auth.errorResponse;
    }

    // Apenas SuperAdmin, Pastor ou Administrador Master podem alterar credenciais bancárias
    const roleCheck = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN']);
    if (!roleCheck.allowed) {
      return roleCheck.errorResponse!;
    }

    const body = JSON.parse(event.body || '{}');
    const tenantCheck = enforceTenant(auth.user, body.organization_id || event.queryStringParameters?.organization_id || event.headers?.['x-organization-id']);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgId = tenantCheck.effectiveOrgId;

    // Recupera chaves existentes para não sobrescrever se vierem mascaradas
    const { rows: existingRows } = await query(`SELECT * FROM payment_gateway_settings WHERE organization_id = ? LIMIT 1`, [orgId]);
    const existing = existingRows[0] || {};

    let apiKey = body.api_key;
    if (apiKey && apiKey.includes('••••')) {
      apiKey = existing.api_key || '';
    }

    let encryptionKey = body.encryption_key;
    if (encryptionKey && encryptionKey.includes('••••')) {
      encryptionKey = existing.encryption_key || '';
    }

    const config = {
      ...DEFAULT_GATEWAY_CONFIG,
      ...body,
      id: uuidv5(orgId, uuidv5.URL),
      organization_id: orgId,
      api_key: apiKey !== undefined ? apiKey : existing.api_key,
      encryption_key: encryptionKey !== undefined ? encryptionKey : existing.encryption_key
    };

    const sql = `
      INSERT INTO payment_gateway_settings (
        id, organization_id, config_payload, environment, api_key, encryption_key, recipient_id,
        bank_code, bank_name, agency, account, account_digit,
        document_number, legal_name, pix_key_type, pix_key,
        auto_split_enabled, fee_percentage
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        config_payload = VALUES(config_payload),
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
      config.id,
      orgId,
      JSON.stringify(Object.fromEntries(Object.entries(body.ui_settings || {}).filter(([key]) => !['secret_key', 'api_key', 'encryption_key', 'public_key', 'is_connected'].includes(key)))),
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

    // Registro de Auditoria de Segurança
    await logSecurityEvent({
      organizationId: orgId,
      user: auth.user,
      action: 'UPDATE_PAYMENT_GATEWAY_CONFIG',
      resource: 'payment_gateway_settings',
      resourceId: config.id || 'default_gateway',
      details: {
        environment: config.environment,
        bank_code: config.bank_code,
        has_api_key: Boolean(config.api_key),
        recipient_id: config.recipient_id
      },
      event
    });

    return apiResponse(200, {
      message: 'Configurações do Gateway salvas com sucesso!',
      config: {
        ...config,
        api_key: maskSecret(config.api_key),
        encryption_key: maskSecret(config.encryption_key)
      }
    });
  } catch (error: any) {
    console.error('Erro ao salvar pagarme-settings:', error);
    return apiResponse(500, { message: 'Erro ao salvar configurações do Gateway' });
  }
};
