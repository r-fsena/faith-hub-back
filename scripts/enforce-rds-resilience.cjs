require('dotenv').config();

const { GetSecretValueCommand, SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
const { DescribeDBInstancesCommand, ModifyDBInstanceCommand, RDSClient } = require('@aws-sdk/client-rds');

async function main() {
  const apply = process.argv.includes('--apply');
  if (!process.env.DB_SECRET_ARN) throw new Error('DB_SECRET_ARN_REQUIRED');
  const secretRegion = process.env.AWS_REGION || 'us-east-2';
  const secretResponse = await new SecretsManagerClient({ region: secretRegion }).send(
    new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN })
  );
  if (!secretResponse.SecretString) throw new Error('DB_SECRET_EMPTY');
  const databaseHost = String(JSON.parse(secretResponse.SecretString).host || '').toLowerCase();
  const rdsRegion = databaseHost.match(/\.([a-z]{2}-[a-z]+-\d)\.rds\.amazonaws\.com$/)?.[1] || process.env.DB_REGION || secretRegion;
  const rds = new RDSClient({ region: rdsRegion });
  const response = await rds.send(new DescribeDBInstancesCommand({}));
  const instance = (response.DBInstances || []).find(item =>
    String(item.Endpoint?.Address || '').toLowerCase() === databaseHost
  );
  if (!instance?.DBInstanceIdentifier) throw new Error('RDS_INSTANCE_NOT_FOUND_FOR_SECRET_HOST');

  const before = {
    identifier: instance.DBInstanceIdentifier,
    backupRetentionDays: instance.BackupRetentionPeriod,
    deletionProtection: instance.DeletionProtection,
    storageEncrypted: instance.StorageEncrypted,
    multiAZ: instance.MultiAZ
  };
  const requiresChange = Number(instance.BackupRetentionPeriod || 0) < 7 || instance.DeletionProtection !== true;
  if (!apply || !requiresChange) {
    console.log(JSON.stringify({ apply, requiresChange, before }, null, 2));
    return;
  }

  const updated = await rds.send(new ModifyDBInstanceCommand({
    DBInstanceIdentifier: instance.DBInstanceIdentifier,
    BackupRetentionPeriod: 7,
    DeletionProtection: true,
    ApplyImmediately: true
  }));
  console.log(JSON.stringify({
    applied: true,
    identifier: updated.DBInstance?.DBInstanceIdentifier,
    backupRetentionDays: updated.DBInstance?.BackupRetentionPeriod,
    deletionProtection: updated.DBInstance?.DeletionProtection,
    status: updated.DBInstance?.DBInstanceStatus
  }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
