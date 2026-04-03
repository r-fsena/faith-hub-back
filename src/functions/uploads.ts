import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
  }
});

function response(statusCode: number, body: any) {
  return {
    statusCode,
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

export const getUploadUrl = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const { filename, contentType, target_route } = event.queryStringParameters || {};
    if (!filename || !contentType) {
      return response(400, { error: 'filename e contentType são obrigatórios' });
    }

    const bucketName = process.env.S3_MEDIA_BUCKET || 'faith-hub-media-bucket-rafaelsena';
    
    // Extensão baseada no nome original (ex: '.jpg', '.mp4')
    const ext = path.extname(filename);
    const uniqueName = `${target_route || 'mural'}/${uuidv4()}${ext}`;

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: uniqueName,
      ContentType: contentType
      // ACL: 'public-read' removido porque a AWS agora bloqueia ACLs por padrão (BucketOwnerEnforced)
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 }); // URL válida por 1 hora
    
    const finalFileUrl = `https://${bucketName}.s3.${process.env.AWS_REGION || 'us-east-2'}.amazonaws.com/${uniqueName}`;

    return response(200, { uploadUrl, fileUrl: finalFileUrl });
  } catch (err: any) {
    console.error('S3 Upload Error:', err);
    return response(500, { error: err.message });
  }
};
