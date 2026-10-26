require('dotenv').config();

const { GetSecretValueCommand, SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
const {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  DescribeDBProxiesCommand,
  DescribeDBProxyTargetsCommand,
  RDSClient
} = require('@aws-sdk/client-rds');

async function main() {
  if (!process.env.DB_SECRET_ARN) throw new Error('DB_SECRET_ARN_REQUIRED');
  const region = process.env.AWS_REGION || 'us-east-2';
  const secrets = new SecretsManagerClient({ region });
  const secretResponse = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN }));
  if (!secretResponse.SecretString) throw new Error('DB_SECRET_EMPTY');
  const databaseSecret = JSON.parse(secretResponse.SecretString);
  const databaseHost = String(databaseSecret.host || '').toLowerCase();
  if (!databaseHost) throw new Error('DB_SECRET_HOST_REQUIRED');
  const endpointRegion = databaseHost.match(/\.([a-z]{2}-[a-z]+-\d)\.rds\.amazonaws\.com$/)?.[1];
  const rdsRegion = endpointRegion || process.env.DB_REGION || region;

  const rds = new RDSClient({ region: rdsRegion });
  const [instancesResponse, clustersResponse, proxiesResponse] = await Promise.all([
    rds.send(new DescribeDBInstancesCommand({})),
    rds.send(new DescribeDBClustersCommand({})),
    rds.send(new DescribeDBProxiesCommand({}))
  ]);

  const allInstances = instancesResponse.DBInstances || [];
  const allClusters = clustersResponse.DBClusters || [];
  const matchingProxies = (proxiesResponse.DBProxies || []).filter(proxy =>
    String(proxy.Endpoint || '').toLowerCase() === databaseHost
  );
  const proxyTargets = (await Promise.all(matchingProxies.map(proxy =>
    rds.send(new DescribeDBProxyTargetsCommand({ DBProxyName: proxy.DBProxyName }))
  ))).flatMap(response => response.Targets || []);
  const proxyResourceIds = new Set(proxyTargets.map(target => target.RdsResourceId).filter(Boolean));

  const instances = allInstances.filter(instance =>
    String(instance.Endpoint?.Address || '').toLowerCase() === databaseHost ||
    (instance.DbiResourceId && proxyResourceIds.has(instance.DbiResourceId))
  );
  const clusters = allClusters.filter(cluster => {
    const endpoints = [cluster.Endpoint, cluster.ReaderEndpoint, ...(cluster.CustomEndpoints || [])]
      .map(value => String(value || '').toLowerCase());
    return endpoints.includes(databaseHost) ||
      (cluster.DbClusterResourceId && proxyResourceIds.has(cluster.DbClusterResourceId)) ||
      (cluster.DBClusterIdentifier && instances.some(instance => instance.DBClusterIdentifier === cluster.DBClusterIdentifier));
  });

  if (!instances.length && !clusters.length) throw new Error('RDS_RESOURCE_NOT_FOUND_FOR_SECRET_HOST');

  const report = {
    secretRegion: region,
    rdsRegion,
    proxies: matchingProxies.map(proxy => ({
      name: proxy.DBProxyName,
      status: proxy.Status,
      engineFamily: proxy.EngineFamily,
      idleClientTimeout: proxy.IdleClientTimeout,
      requireTLS: proxy.RequireTLS
    })),
    instances: instances.map(instance => ({
      identifier: instance.DBInstanceIdentifier,
      engine: instance.Engine,
      status: instance.DBInstanceStatus,
      backupRetentionDays: instance.BackupRetentionPeriod,
      deletionProtection: instance.DeletionProtection,
      storageEncrypted: instance.StorageEncrypted,
      multiAZ: instance.MultiAZ,
      autoMinorVersionUpgrade: instance.AutoMinorVersionUpgrade,
      performanceInsightsEnabled: instance.PerformanceInsightsEnabled,
      latestRestorableTime: instance.LatestRestorableTime || null
    })),
    clusters: clusters.map(cluster => ({
      identifier: cluster.DBClusterIdentifier,
      engine: cluster.Engine,
      status: cluster.Status,
      backupRetentionDays: cluster.BackupRetentionPeriod,
      deletionProtection: cluster.DeletionProtection,
      storageEncrypted: cluster.StorageEncrypted,
      multiAZ: cluster.MultiAZ,
      latestRestorableTime: cluster.LatestRestorableTime || null
    }))
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
