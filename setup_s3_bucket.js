const { S3Client, CreateBucketCommand, PutPublicAccessBlockCommand, PutBucketAclCommand, PutBucketCorsCommand, PutBucketPolicyCommand } = require("@aws-sdk/client-s3");
require("dotenv").config();

const BUCKET_NAME = process.env.S3_MEDIA_BUCKET || 'faith-hub-media-bucket-rafaelsena';

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

async function run() {
  try {
    console.log(`Verificando/Criando S3 Bucket: ${BUCKET_NAME}...`);
    try {
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET_NAME }));
      console.log("Bucket criado!");
    } catch (e) {
      if (e.name === 'BucketAlreadyOwnedByYou' || e.name === 'BucketAlreadyExists') {
        console.log("Bucket já existe e está sob sua autoridade.");
      } else {
        throw e;
      }
    }

    console.log("Desbloqueando acesso público ACLs...");
    await s3.send(new PutPublicAccessBlockCommand({
      Bucket: BUCKET_NAME,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        IgnorePublicAcls: false,
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false
      }
    }));

    console.log("Configurando CORS para permitir uploads pelo React Native / Web...");
    await s3.send(new PutBucketCorsCommand({
      Bucket: BUCKET_NAME,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedHeaders: ["*"],
            AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
            AllowedOrigins: ["*"],
            ExposeHeaders: []
          }
        ]
      }
    }));

    console.log("Aplicando Bucket Policy para permitir leitura pública...");
    const policy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "PublicReadGetObject",
          Effect: "Allow",
          Principal: "*",
          Action: "s3:GetObject",
          Resource: `arn:aws:s3:::${BUCKET_NAME}/*`
        }
      ]
    };
    
    await s3.send(new PutBucketPolicyCommand({
      Bucket: BUCKET_NAME,
      Policy: JSON.stringify(policy)
    }));

    console.log("✓ S3 Configurado com sucesso para uploads de Mídia do Faith Hub!");
  } catch (err) {
    console.error("Erro ao configurar S3:", err);
  }
}

run();
