import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import { apiResponse } from '../db';

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-2',
  credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  } : undefined
});

export const getUploadUrl = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const { filename, contentType, target_route, prefix } = event.queryStringParameters || {};
    const type = contentType || 'image/jpeg';
    const folder = prefix || target_route || 'general';

    const bucketName = process.env.S3_MEDIA_BUCKET || 'faith-hub-media-bucket-rafaelsena';
    
    let ext = filename ? path.extname(filename) : '';
    if (!ext) {
      if (type.includes('png')) ext = '.png';
      else if (type.includes('jpeg') || type.includes('jpg')) ext = '.jpg';
      else if (type.includes('webp')) ext = '.webp';
      else if (type.includes('pdf')) ext = '.pdf';
      else if (type.includes('mp4')) ext = '.mp4';
      else ext = '.bin';
    }

    const uniqueName = `${folder}/${uuidv4()}${ext}`;

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: uniqueName,
      ContentType: type
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    const finalFileUrl = `https://${bucketName}.s3.${process.env.AWS_REGION || 'us-east-2'}.amazonaws.com/${uniqueName}`;

    return apiResponse(200, { uploadUrl, fileUrl: finalFileUrl, publicUrl: finalFileUrl });
  } catch (err: any) {
    console.error('S3 Upload Presigned URL Error:', err);
    return apiResponse(500, { error: err.message });
  }
};
