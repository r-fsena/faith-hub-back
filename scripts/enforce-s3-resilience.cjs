require('dotenv').config();

const {
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  S3Client
} = require('@aws-sdk/client-s3');

async function main() {
  if (!process.argv.includes('--apply')) throw new Error('USE_--apply_TO_CONFIRM');
  const bucket = process.env.S3_MEDIA_BUCKET || 'faith-hub-media-bucket-rafaelsena';
  const region = process.env.AWS_REGION || 'us-east-2';
  const s3 = new S3Client({ region });

  await s3.send(new PutBucketVersioningCommand({
    Bucket: bucket,
    VersioningConfiguration: { Status: 'Enabled' }
  }));
  await s3.send(new PutBucketLifecycleConfigurationCommand({
    Bucket: bucket,
    LifecycleConfiguration: {
      Rules: [
        {
          ID: 'faith-hub-abort-incomplete-uploads',
          Status: 'Enabled',
          Filter: { Prefix: '' },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }
        },
        {
          ID: 'faith-hub-expire-noncurrent-versions',
          Status: 'Enabled',
          Filter: { Prefix: '' },
          NoncurrentVersionExpiration: { NoncurrentDays: 90, NewerNoncurrentVersions: 3 }
        }
      ]
    }
  }));

  console.log(JSON.stringify({
    applied: true,
    bucket,
    versioning: 'Enabled',
    abortIncompleteUploadsAfterDays: 7,
    expireNoncurrentVersionsAfterDays: 90,
    retainedNewerNoncurrentVersions: 3
  }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
