import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHash } from 'crypto';
import { apiResponse, query } from '../db';
import { checkRateLimit } from '../services/rateLimiter';
import { evaluateTenantFlags } from '../services/featureFlagService';

const DOCUMENT_LABELS: Record<string, string> = {
  PRESENTATION_LETTER: 'Carta de apresentação',
  TRANSFER_LETTER: 'Carta de transferência',
  BAPTISM_CERTIFICATE: 'Certificado de batismo',
  DECLARATION: 'Declaração',
  OTHER: 'Documento eclesiástico'
};

export const verifyDocument = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const rateLimit = await checkRateLimit(event, { maxRequests: 30, windowSeconds: 300, identifierPrefix: 'secretariat-document-verification' });
    if (!rateLimit.allowed) return rateLimit.errorResponse!;

    const token = decodeURIComponent(event.pathParameters?.token || '').trim();
    const match = token.match(/^([a-zA-Z0-9_-]{1,36})\.([a-zA-Z0-9_-]{40,})$/);
    if (!match) return apiResponse(404, { valid: false, message: 'Documento não encontrado.' });
    const organizationId = match[1];
    const flags = await evaluateTenantFlags(organizationId, null, 'production');
    if (!flags.flags['secretariat.public_verification']) {
      return apiResponse(404, { valid: false, message: 'Verificação pública indisponível.' });
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const result = await query(`SELECT d.document_number, d.document_type, d.template_version,
        d.status, d.issued_at, d.revoked_at, d.file_checksum, o.name AS organization_name
      FROM issued_documents d
      INNER JOIN organizations o ON o.id = d.organization_id
      WHERE d.organization_id = ? AND d.verification_token_hash = ? LIMIT 1`,
    [organizationId, tokenHash]);
    const document = result.rows[0];
    if (!document) return apiResponse(404, { valid: false, message: 'Documento não encontrado.' });
    return apiResponse(200, {
      valid: document.status === 'VALID',
      document: {
        document_number: document.document_number,
        document_type: document.document_type,
        document_label: DOCUMENT_LABELS[document.document_type] || DOCUMENT_LABELS.OTHER,
        template_version: document.template_version,
        status: document.status,
        issued_at: document.issued_at,
        revoked_at: document.revoked_at,
        checksum: document.file_checksum,
        organization_name: document.organization_name
      }
    });
  } catch (error) {
    console.error('Erro na verificação pública de documento:', error);
    return apiResponse(503, { valid: false, message: 'Não foi possível verificar o documento agora.' });
  }
};
