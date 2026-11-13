const fs=require('node:fs'),crypto=require('node:crypto');
const schema=require('./scripts/foundation-schema.cjs');
const migrationId='20261108_002_intelligence_foundations';
const additions={'intelligence.history':'Histórico observado de cadastro e vínculos','financial.accounts_ledger':'Contas financeiras e liquidações registradas'};
function extend(value){const result={...value},base=value['intelligence.overview']??value['content.analytics_dashboard']===true;
 if(result['intelligence.history']===undefined)result['intelligence.history']=!!base&&value['members.module_enabled']===true;
 if(result['financial.accounts_ledger']===undefined)result['financial.accounts_ledger']=value['financial.module_enabled']===true&&value['financial.cashflow_ledger']===true;return result;
}
module.exports={migrationId,additions,extend};
if(require.main===module){require('dotenv').config({quiet:true});const {createAdminConnection}=require('./scripts/db-admin.cjs');
 (async()=>{const db=await createAdminConnection();let locked=false;try{
 const checksum=crypto.createHash('sha256').update(fs.readFileSync(__filename)).update(fs.readFileSync(require.resolve('./scripts/foundation-schema.cjs'))).digest('hex');
 const [lock]=await db.query("SELECT GET_LOCK('faith_hub_schema_migrations',30) AS acquired");locked=Number(lock[0].acquired)===1;if(!locked)throw Error('MIGRATION_LOCK_TIMEOUT');
 const [applied]=await db.query('SELECT checksum FROM schema_migrations WHERE migration_id = ?',[migrationId]);
 const [settings]=await db.query('SELECT @@log_bin AS binlog_enabled,@@log_bin_trust_function_creators AS trust_creators,@@binlog_format AS binlog_format');const triggerPrerequisiteReady=!Number(settings[0].binlog_enabled)||!!Number(settings[0].trust_creators)&&settings[0].binlog_format==='ROW';
 if(process.argv.includes('--status')){console.log(JSON.stringify({migrationId,applied:!!applied.length,checksumMatches:!applied.length||applied[0].checksum===checksum,triggerPrerequisiteReady,binlogFormat:settings[0].binlog_format}));return;}
 if(applied.length){if(applied[0].checksum!==checksum)throw Error('MIGRATION_CHECKSUM_MISMATCH');console.log('ALREADY_APPLIED');return;}
 if(!triggerPrerequisiteReady)throw Error('HISTORY_TRIGGERS_BLOCKED: MySQL binary logging requires approved log_bin_trust_function_creators=1 and ROW binlog. No schema or flags were changed.');
 for(const sql of schema.tables)await db.query(sql);
 for(const [column,definition]of Object.entries(schema.columns)){const [found]=await db.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='church_financial_transactions' AND COLUMN_NAME=?",[column]);if(!found.length)await db.query(`ALTER TABLE church_financial_transactions ADD COLUMN ${column} ${definition}`);}
 await db.query(schema.reportingView);
 for(const sql of schema.triggers){const name=sql.match(/^CREATE TRIGGER (\w+)/)[1];const [found]=await db.query('SELECT ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=?',[name]);if(!found.length)await db.query(sql);}
 if(process.argv.includes('--schema-only')){console.log(JSON.stringify({migrationId,schemaReady:true,flagsChanged:false}));return;}
 await db.beginTransaction();try{
 for(const [key,description]of Object.entries(additions))for(const [org,enabled,env]of [['global',0,'all'],['org_default',1,'production']]){
 const id='ff_found_'+crypto.createHash('sha256').update(org+key).digest('hex').slice(0,24);
 await db.query(`INSERT INTO tenant_feature_flags(id,organization_id,campus_id,environment,feature_key,is_enabled,category,description,updated_by)
 VALUES(?,?,NULL,?,?,?,'Inteligência',?,'foundations-migration') ON DUPLICATE KEY UPDATE description=VALUES(description)`,[id,org,env,key,enabled,description]);}
 const [plans]=await db.query('SELECT id,entitlements FROM saas_plans WHERE entitlements IS NOT NULL');
 for(const plan of plans){const value=typeof plan.entitlements==='string'?JSON.parse(plan.entitlements):plan.entitlements;if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_PLAN_ENTITLEMENTS');await db.query('UPDATE saas_plans SET entitlements = ? WHERE id = ?',[JSON.stringify(extend(value)),plan.id]);}
 await db.query('INSERT IGNORE INTO church_financial_ledger_rollout(organization_id,activated_at) VALUES(?,UTC_TIMESTAMP())',['org_default']);
 const [coverage]=await db.query('SELECT organization_id FROM member_history_coverage WHERE organization_id = ? FOR UPDATE',['org_default']);
 if(!coverage.length)await schema.initializeHistoryBaseline(db,'org_default',null);
 await db.query(`INSERT INTO security_audit_logs(id,organization_id,user_email,user_role,action,resource,resource_id,details,status)
 VALUES(UUID(),'org_default','system@faithhubs.com','SYSTEM','INTELLIGENCE_FOUNDATIONS_MIGRATION','schema_migrations',?,?,'SUCCESS')`,[migrationId,JSON.stringify({pilot:'org_default',historicalPastInvented:false,financialAmountsChanged:false,chargesChanged:false})]);
 await db.query('INSERT INTO schema_migrations(migration_id,checksum) VALUES(?,?)',[migrationId,checksum]);await db.commit();
 }catch(error){await db.rollback();throw error;}
 console.log(JSON.stringify({migrationId,applied:true,pilot:'org_default',financialAmountsChanged:false,chargesChanged:false}));
 }finally{if(locked)await db.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");await db.end();}})().catch(e=>{console.error(e.message);process.exitCode=1;});}
