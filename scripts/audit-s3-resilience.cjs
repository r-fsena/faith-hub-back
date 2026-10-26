require('dotenv').config();

const {
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  S3Client
} = require('@aws-sdk/client-s3');

async function optional(client, command) {
  try {
    return await client.send(command);
  } catch (error) {
    if (['NoSuchConfiguration', 'NoSuchLifecycleConfiguration', 'NoSuchPublicAccessBlockConfiguration', 'ServerSideEncryptionConfigurationNotFoundError'].includes(error?.name)) return null;
    throw error;
  }
}

async function main() {
  const bucket = process.env.S3_MEDIA_BUCKET || 'faith-hub-media-bucket-rafaelsena';
  const region = process.env.AWS_REGION || 'us-east-2';
  const s3 = new S3Client({ region });
  const [versioning, encryption, publicAccess, lifecycle] = await Promise.all([
    optional(s3, new GetBucketVersioningCommand({ Bucket: bucket })),
    optional(s3, new GetBucketEncryptionCommand({ Bucket: bucket })),
    optional(s3, new GetPublicAccessBlockCommand({ Bucket: bucket })),
    optional(s3, new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }))
  ]);

  console.log(JSON.stringify({
    bucket,
    region,
    versioning: versioning?.Status || 'Disabled',
    encryptionAlgorithms: (encryption?.ServerSideEncryptionConfiguration?.Rules || [])
      .map(rule => rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm)
      .filter(Boolean),
    publicAccessBlock: publicAccess?.PublicAccessBlockConfiguration || null,
    lifecycleRules: (lifecycle?.Rules || []).map(rule => ({ id: rule.ID, status: rule.Status }))
  }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
