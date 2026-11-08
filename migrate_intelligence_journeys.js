const fs=require('fs'),crypto=require('crypto');
const migrationId='20261107_001_intelligence_journeys';
const tables=[
`CREATE TABLE IF NOT EXISTS intelligence_invitation_events (
 organization_id VARCHAR(100) NOT NULL,id CHAR(64) NOT NULL,user_id VARCHAR(100) NOT NULL,campus_id VARCHAR(100) NOT NULL,
 source VARCHAR(16) NOT NULL,outcome VARCHAR(16) NOT NULL,occurred_at DATETIME NOT NULL,
 PRIMARY KEY(organization_id,id),KEY idx_int_inv_user(organization_id,user_id,occurred_at),KEY idx_int_inv_date(organization_id,campus_id,occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS intelligence_welcome_state (
 organization_id VARCHAR(100) NOT NULL,visitor_id VARCHAR(100) NOT NULL,version INT NOT NULL DEFAULT 0,baseline_known TINYINT NOT NULL DEFAULT 0,
 linked_member_id VARCHAR(100) NULL,tracked_since DATETIME NOT NULL,contacted_at DATETIME NULL,referred_at DATETIME NULL,
 linked_at DATETIME NULL,attended_at DATETIME NULL,integrated_at DATETIME NULL,
 PRIMARY KEY(organization_id,visitor_id),UNIQUE KEY uq_int_welcome_member(organization_id,linked_member_id),
 KEY idx_int_welcome_contact(organization_id,contacted_at),KEY idx_int_welcome_link(organization_id,linked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS intelligence_welcome_events (
 organization_id VARCHAR(100) NOT NULL,id CHAR(36) NOT NULL,visitor_id VARCHAR(100) NOT NULL,campus_id VARCHAR(100) NOT NULL,
 cell_group_id VARCHAR(100) NULL,actor_id VARCHAR(100) NULL,kind VARCHAR(32) NOT NULL,previous_stage VARCHAR(24) NULL,
 stage VARCHAR(24) NOT NULL,occurred_at DATETIME NOT NULL,version INT NOT NULL,
 PRIMARY KEY(organization_id,id),UNIQUE KEY uq_int_welcome_version(organization_id,visitor_id,version),KEY idx_int_welcome_date(organization_id,campus_id,occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS intelligence_actions (
 organization_id VARCHAR(100) NOT NULL,id CHAR(36) NOT NULL,campus_id VARCHAR(100) NOT NULL,cell_group_id VARCHAR(100) NULL,
 subject_type VARCHAR(16) NOT NULL,subject_id VARCHAR(100) NOT NULL,owner_id VARCHAR(100) NOT NULL,created_by VARCHAR(100) NOT NULL,
 title VARCHAR(140) NOT NULL,status VARCHAR(16) NOT NULL DEFAULT 'NEW',due_date DATE NOT NULL,snoozed_until DATE NULL,
 resolution VARCHAR(24) NULL,dedup_key CHAR(64) NOT NULL,request_hash CHAR(64) NOT NULL,version INT NOT NULL DEFAULT 0,
 created_at DATETIME NOT NULL,updated_at DATETIME NOT NULL,closed_at DATETIME NULL,
 PRIMARY KEY(organization_id,id),UNIQUE KEY uq_int_action_dedup(organization_id,dedup_key),KEY idx_int_action_scope(organization_id,campus_id,status,due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS intelligence_goals (
 organization_id VARCHAR(100) NOT NULL,id CHAR(36) NOT NULL,campus_id VARCHAR(100) NOT NULL,cell_group_id VARCHAR(100) NULL,
 metric VARCHAR(32) NOT NULL,owner_id VARCHAR(100) NOT NULL,title VARCHAR(140) NOT NULL,target_count INT UNSIGNED NOT NULL,
 start_date DATE NOT NULL,end_date DATE NOT NULL,status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',version INT NOT NULL DEFAULT 0,request_hash CHAR(64) NOT NULL,
 created_by VARCHAR(100) NOT NULL,created_at DATETIME NOT NULL,updated_at DATETIME NOT NULL,
 PRIMARY KEY(organization_id,id),KEY idx_int_goal_scope(organization_id,campus_id,status,end_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];
const additions={
 'intelligence.activation':'Ativação do PWA e tentativas de convite',
 'intelligence.member_journey':'Jornada e coortes de acolhimento',
 'intelligence.actions':'Ações com responsável e acompanhamento',
 'intelligence.goals':'Metas com progresso verificável'
};
function extend(entitlements){
 const overview=entitlements['intelligence.overview']??entitlements['content.analytics_dashboard']===true;
 for(const key of Object.keys(additions))if(entitlements[key]===undefined)entitlements[key]=!!overview&&(key!=='intelligence.member_journey'||entitlements['visitors.module_enabled']===true);
 return entitlements;
}
module.exports={tables,additions,extend};
if(require.main===module){
 require('dotenv').config();const {createAdminConnection}=require('./scripts/db-admin.cjs');
 (async()=>{const db=await createAdminConnection();let locked=false;try{
 const checksum=crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
 const [locks]=await db.query("SELECT GET_LOCK('faith_hub_schema_migrations',30) AS acquired");locked=Number(locks[0].acquired)===1;if(!locked)throw Error('MIGRATION_LOCK_TIMEOUT');
 const [applied]=await db.query('SELECT checksum FROM schema_migrations WHERE migration_id = ?',[migrationId]);
 if(process.argv.includes('--status')){console.log(JSON.stringify({migrationId,applied:!!applied.length,checksumMatches:!applied.length||applied[0].checksum===checksum}));return;}
 if(applied.length){if(applied[0].checksum!==checksum)throw Error('MIGRATION_CHECKSUM_MISMATCH');console.log('ALREADY_APPLIED');return;}
 for(const sql of tables)await db.query(sql);
 if(process.argv.includes('--schema-only')){console.log(JSON.stringify({migrationId,schemaReady:true,flagsChanged:false}));return;}
 await db.beginTransaction();try{
 for(const [key,description]of Object.entries(additions))for(const [org,enabled,env]of [['global',0,'all'],['org_default',1,'production']]){
 const id='ff_journey_'+crypto.createHash('sha256').update(org+key).digest('hex').slice(0,24);
 await db.query(`INSERT INTO tenant_feature_flags(id,organization_id,campus_id,environment,feature_key,is_enabled,category,description,updated_by)
 VALUES(?,?,NULL,?,?,?,'Inteligência',?,'intelligence-journeys-migration') ON DUPLICATE KEY UPDATE description=VALUES(description)`,[id,org,env,key,enabled,description]);
 }
 const [plans]=await db.query('SELECT id,entitlements FROM saas_plans WHERE entitlements IS NOT NULL');
 for(const plan of plans){const value=typeof plan.entitlements==='string'?JSON.parse(plan.entitlements):plan.entitlements;if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_PLAN_ENTITLEMENTS');await db.query('UPDATE saas_plans SET entitlements = ? WHERE id = ?',[JSON.stringify(extend(value)),plan.id]);}
 await db.query(`INSERT INTO security_audit_logs(id,organization_id,user_email,user_role,action,resource,resource_id,details,status)
 VALUES(UUID(),'org_default','system@faithhubs.com','SYSTEM','INTELLIGENCE_JOURNEYS_MIGRATION','schema_migrations',?,?,'SUCCESS')`,[migrationId,JSON.stringify({pilot:'org_default',historicalMilestonesInvented:false,chargesChanged:false})]);
 await db.query('INSERT INTO schema_migrations(migration_id,checksum) VALUES(?,?)',[migrationId,checksum]);await db.commit();
 }catch(e){await db.rollback();throw e;}
 console.log(JSON.stringify({migrationId,applied:true,pilot:'org_default',chargesChanged:false}));
 }finally{if(locked)await db.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");await db.end();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
}
