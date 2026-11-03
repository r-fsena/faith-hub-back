require('dotenv').config();
const crypto=require('crypto');
const {createAdminConnection}=require('./scripts/db-admin.cjs');
const migrationId='20261103_002_public_journey';
const checksum=crypto.createHash('sha256').update('public-journey-v1-conectar-assisted-14d').digest('hex');
async function main(){const db=await createAdminConnection();let locked=false;try{
 const [locks]=await db.query("SELECT GET_LOCK('faith_hub_schema_migrations',30) AS acquired");locked=Number(locks[0].acquired)===1;if(!locked)throw Error('MIGRATION_LOCK_TIMEOUT');
 const [applied]=await db.query('SELECT checksum FROM schema_migrations WHERE migration_id = ?',[migrationId]);
 if(process.argv.includes('--status')){console.log(JSON.stringify({migrationId,status:applied.length?'APPLIED':'PENDING',checksumMatches:!applied.length||applied[0].checksum===checksum}));return;}
 if(applied.length){if(applied[0].checksum!==checksum)throw Error('MIGRATION_CHECKSUM_MISMATCH');console.log('ALREADY_APPLIED');return;}
 await db.query(`CREATE TABLE IF NOT EXISTS saas_acquisitions (
 id VARCHAR(36) PRIMARY KEY, owner_sub VARCHAR(80) NOT NULL, owner_email VARCHAR(254) NOT NULL,
 contact_name VARCHAR(150) NOT NULL, contact_phone VARCHAR(40) NULL, church_name VARCHAR(180) NOT NULL,
 document VARCHAR(20) NULL, plan_id VARCHAR(50) NOT NULL, mode VARCHAR(10) NOT NULL,
 status VARCHAR(30) NOT NULL DEFAULT 'DRAFT', plan_contract JSON NOT NULL,
 organization_id VARCHAR(36) NULL, proposal_id VARCHAR(36) NULL, source JSON NULL,
 terms_version VARCHAR(40) NOT NULL, terms_accepted_at DATETIME NOT NULL,
 trial_approved_at DATETIME NULL, trial_started_at DATETIME NULL, trial_expires_at DATETIME NULL,
 last_error VARCHAR(300) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY uq_acquisition_owner (owner_sub), UNIQUE KEY uq_acquisition_proposal (proposal_id),
 KEY idx_acquisition_org (organization_id), KEY idx_acquisition_status (status,created_at)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
 for(const [column,type] of [['trial_started_at','DATETIME NULL'],['trial_expires_at','DATETIME NULL'],['trial_pending_start','TINYINT NOT NULL DEFAULT 0']]){
 const [exists]=await db.query('SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',['organizations',column]);
 if(!exists.length)await db.query(`ALTER TABLE organizations ADD COLUMN ${column} ${type}`);
 }
 await db.beginTransaction();try{
 for(const [key,description] of [['system.saas_public_journey','Contratação pública e solicitação de teste Conectar'],['system.saas_public_checkout','Checkout público com identidade verificada'],['system.saas_public_onboarding','Ativação e onboarding da jornada pública']]){
 const id='ff_'+crypto.createHash('sha256').update(key).digest('hex').slice(0,30);
 // Public pages/trial requests can be released; paid checkout starts disabled until provider readiness is checked.
 await db.query(`INSERT INTO tenant_feature_flags (id,organization_id,campus_id,environment,feature_key,is_enabled,category,description,updated_by)
 VALUES (?,'global',NULL,'all',?,?, 'Jornada pública',?,'public-journey-migration') ON DUPLICATE KEY UPDATE description=VALUES(description)`,[id,key,key==='system.saas_public_checkout'?0:1,description]);
 }
 await db.query(`INSERT INTO security_audit_logs (id,organization_id,user_email,user_role,action,resource,resource_id,details,status)
 VALUES (UUID(),'org_default','system@faithhubs.com','SYSTEM','PUBLIC_JOURNEY_MIGRATION','schema_migrations',?,?,'SUCCESS')`,[migrationId,JSON.stringify({trial_plan:'CONECTAR',days:14,paidCheckoutEnabled:false})]);
 await db.query('INSERT INTO schema_migrations (migration_id,checksum) VALUES (?,?)',[migrationId,checksum]);await db.commit();
 }catch(e){await db.rollback();throw e;}
 console.log(JSON.stringify({migrationId,status:'APPLIED',publicCheckoutEnabled:false}));
 }finally{if(locked)await db.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");await db.end();}}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
