require('dotenv').config();
const fs = require('fs'), crypto = require('crypto');
const {createAdminConnection} = require('./scripts/db-admin.cjs');
const migrationId = '20261106_001_intelligence_foundation';
const checksum = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
const tables = [
`CREATE TABLE IF NOT EXISTS intelligence_consent (
 organization_id VARCHAR(100) NOT NULL,user_id VARCHAR(100) NOT NULL,allowed TINYINT NOT NULL DEFAULT 0,
 policy_version VARCHAR(40) NOT NULL,revision INT NOT NULL DEFAULT 0,updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS intelligence_event_receipts (
 organization_id VARCHAR(100) NOT NULL,event_id VARCHAR(100) NOT NULL,subject_key CHAR(64) NOT NULL,
 occurred_at DATETIME NOT NULL,received_at DATETIME NOT NULL,PRIMARY KEY(organization_id,event_id),
 KEY idx_intelligence_receipt_subject(organization_id,subject_key),KEY idx_intelligence_receipt_date(organization_id,received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS intelligence_activity_daily (
 organization_id VARCHAR(100) NOT NULL,campus_id VARCHAR(100) NOT NULL,activity_date DATE NOT NULL,
 subject_key CHAR(64) NOT NULL,session_key CHAR(64) NOT NULL,module VARCHAR(30) NOT NULL,experience_version VARCHAR(2) NOT NULL,
 actor_kind VARCHAR(10) NOT NULL,cell_group_id VARCHAR(100) NOT NULL DEFAULT '',interactions INT UNSIGNED NOT NULL DEFAULT 0,
 first_at DATETIME NOT NULL,last_at DATETIME NOT NULL,
 PRIMARY KEY(organization_id,campus_id,activity_date,subject_key,session_key,module,experience_version,cell_group_id),
 KEY idx_intelligence_daily_subject(organization_id,subject_key),KEY idx_intelligence_daily_cell(organization_id,cell_group_id,activity_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS intelligence_member_snapshots (
 organization_id VARCHAR(100) NOT NULL,campus_id VARCHAR(100) NOT NULL,snapshot_date DATE NOT NULL,
 cell_group_id VARCHAR(100) NOT NULL DEFAULT '',active_members INT NOT NULL DEFAULT 0,
 PRIMARY KEY(organization_id,campus_id,snapshot_date,cell_group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS intelligence_measurement (
 organization_id VARCHAR(100) NOT NULL,campus_id VARCHAR(100) NOT NULL,started_at DATETIME NOT NULL,last_event_at DATETIME NULL,last_processed_at DATETIME NULL,
 PRIMARY KEY(organization_id,campus_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];
(async()=>{
 const db=await createAdminConnection();let locked=false;
 try {
  const [locks]=await db.query("SELECT GET_LOCK('faith_hub_schema_migrations',30) AS acquired");
  locked=Number(locks[0].acquired)===1;if(!locked)throw Error('MIGRATION_LOCK_TIMEOUT');
  const [applied]=await db.query('SELECT checksum FROM schema_migrations WHERE migration_id = ?',[migrationId]);
  if(process.argv.includes('--status')){console.log(JSON.stringify({migrationId,applied:!!applied.length,checksumMatches:!applied.length||applied[0].checksum===checksum}));return;}
  if(applied.length){if(applied[0].checksum!==checksum)throw Error('MIGRATION_CHECKSUM_MISMATCH');console.log('ALREADY_APPLIED');return;}
  for(const sql of tables)await db.query(sql);
  if(process.argv.includes('--schema-only')){console.log(JSON.stringify({migrationId,schemaReady:true,flagsChanged:false}));return;}
  await db.beginTransaction();
  try {
   for(const [key,description] of [['intelligence.overview','Visão executiva, comparação e qualidade dos dados'],['intelligence.usage_collection','Coleta opcional de uso do PWA, mediante autorização do membro adulto']]){
    for(const [org,enabled,env] of [['global',0,'all'],['org_default',1,'production']]){
     const id='ff_int_'+crypto.createHash('sha256').update(org+key).digest('hex').slice(0,24);
     await db.query(`INSERT INTO tenant_feature_flags(id,organization_id,campus_id,environment,feature_key,is_enabled,category,description,updated_by)
      VALUES(?,?,NULL,?,?,?,'Inteligência',?,'intelligence-migration') ON DUPLICATE KEY UPDATE description=VALUES(description)`,[id,org,env,key,enabled,description]);
    }
   }
   // Additive entitlement compatibility: no price/capacity change and no rewriting of proposals or customer snapshots.
   const [plans]=await db.query('SELECT id,entitlements FROM saas_plans WHERE entitlements IS NOT NULL');
   for(const plan of plans){
    const old=typeof plan.entitlements==='string'?JSON.parse(plan.entitlements):plan.entitlements;
    if(!old||typeof old!=='object')throw Error('PLAN_ENTITLEMENTS_INVALID');
    for(const key of ['intelligence.overview','intelligence.usage_collection']) if(old[key]===undefined)old[key]=old['content.analytics_dashboard']===true;
    await db.query('UPDATE saas_plans SET entitlements = ? WHERE id = ?',[JSON.stringify(old),plan.id]);
   }
   await db.query(`INSERT INTO security_audit_logs(id,organization_id,user_email,user_role,action,resource,resource_id,details,status)
    VALUES(UUID(),'org_default','system@faithhubs.com','SYSTEM','INTELLIGENCE_FOUNDATION_MIGRATION','schema_migrations',?,?,'SUCCESS')`,[migrationId,JSON.stringify({pilot:'org_default',consentDefault:false,existingChargesChanged:false})]);
   await db.query('INSERT INTO schema_migrations(migration_id,checksum) VALUES(?,?)',[migrationId,checksum]);
   await db.commit();
  }catch(e){await db.rollback();throw e;}
  console.log(JSON.stringify({migrationId,applied:true,pilot:'org_default',consentDefault:false}));
 }finally{if(locked)await db.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");await db.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
