import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import { apiResponse } from '../db';
import { requireAuth, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';
import { checkRateLimit } from '../services/rateLimiter';

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-2',
  credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  } : undefined
});

// Whitelist de tipos MIME e extensões permitidas
const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'video/mp4',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav'
];

const FORBIDDEN_EXTENSIONS = [
  '.exe', '.sh', '.bat', '.cmd', '.vbs', '.php', '.phtml',
  '.js', '.ts', '.py', '.rb', '.pl', '.cgi', '.html', '.htm', '.svg'
];

export const getUploadUrl = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    // 0. Rate Limiting: Máximo de 15 uploads por minuto por IP
    const rateCheck = checkRateLimit(event, {
      maxRequests: 15,
      windowSeconds: 60,
      identifierPrefix: 'uploads_presigned'
    });
    if (!rateCheck.allowed) return rateCheck.errorResponse!;

    const user = await getAuthenticatedUser(event);
    const orgId = user?.organizationId || 'org_default';

    const { filename, contentType, target_route, prefix } = event.queryStringParameters || {};
    const type = (contentType || 'image/jpeg').toLowerCase();
    const folder = prefix || target_route || 'general';

    // 1. Validação de MIME Type
    if (!ALLOWED_MIME_TYPES.includes(type)) {
      return apiResponse(400, {
        error: 'INVALID_MIME_TYPE',
        message: `Tipo de arquivo não permitido (${type}). Formatos aceitos: JPG, PNG, WEBP, GIF, PDF, MP4, MP3.`
      });
    }

    // 2. Validação de Extensão
    let ext = filename ? path.extname(filename).toLowerCase() : '';
    if (ext && FORBIDDEN_EXTENSIONS.includes(ext)) {
      return apiResponse(400, {
        error: 'FORBIDDEN_FILE_EXTENSION',
        message: `Extensão de arquivo proibida por motivos de segurança (${ext}).`
      });
    }

    if (!ext) {
      if (type.includes('png')) ext = '.png';
      else if (type.includes('jpeg') || type.includes('jpg')) ext = '.jpg';
      else if (type.includes('webp')) ext = '.webp';
      else if (type.includes('gif')) ext = '.gif';
      else if (type.includes('pdf')) ext = '.pdf';
      else if (type.includes('mp4')) ext = '.mp4';
      else if (type.includes('mp3') || type.includes('mpeg')) ext = '.mp3';
      else ext = '.bin';
    }

    const bucketName = process.env.S3_MEDIA_BUCKET || 'faith-hub-media-bucket-rafaelsena';
    
    // Isolamento de arquivos no S3 por Tenant / Organização
    const uniqueKey = `${orgId}/${folder}/${uuidv4()}${ext}`;

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: uniqueKey,
      ContentType: type
    });

    // URL com expiração de 15 minutos (900s)
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });
    const finalFileUrl = `https://${bucketName}.s3.${process.env.AWS_REGION || 'us-east-2'}.amazonaws.com/${uniqueKey}`;

    return apiResponse(200, {
      uploadUrl,
      fileUrl: finalFileUrl,
      publicUrl: finalFileUrl,
      expiresInSeconds: 900
    });
  } catch (err: any) {
    console.error('S3 Upload Presigned URL Error:', err);
    return apiResponse(500, { error: 'Erro ao gerar URL segura de upload' });
  }
};
