const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

async function testUpload() {
  try {
    const bucketName = process.env.S3_MEDIA_BUCKET || 'faith-hub-media-bucket-rafaelsena';
    console.log("Teste de Upload para:", bucketName);

    const s3 = new S3Client({
      region: process.env.AWS_REGION || "us-east-2",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    });

    const uniqueName = `test-upload-${uuidv4()}.txt`;

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: uniqueName,
      ContentType: "text/plain"
    });

    console.log("Gerando Presigned URL...");
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    console.log("URL Gerada:", uploadUrl);

    console.log("Enviando requisição PUT para o S3 via fetch...");
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "text/plain"
      },
      body: "Este é um arquivo de teste vindo do Node.js"
    });

    if (response.ok) {
      console.log("✅ Upload concluído com sucesso via URL Assinada!");
      console.log(`URL final pública: https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${uniqueName}`);
    } else {
      console.error("❌ Falha no Upload! S3 Retornou:");
      console.error("Status:", response.status);
      console.error("Erro completo:", await response.text());
    }

  } catch (err) {
    console.error("Erro geral no script:", err);
  }
}

testUpload();
