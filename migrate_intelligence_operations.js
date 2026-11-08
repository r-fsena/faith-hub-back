const fs=require('node:fs'),crypto=require('node:crypto');
const migrationId='20261108_001_intelligence_operations';
const additions={'intelligence.finance':'Inteligência financeira da tesouraria','intelligence.operations':'Inteligência de operações','intelligence.multicampus':'Consolidação de gestão por unidade'};
function extend(input){const result={...input},base=input['intelligence.overview']??input['content.analytics_dashboard']===true;
 const values={'intelligence.finance':!!base&&input['financial.cashflow_ledger']===true,'intelligence.operations':!!base&&['events.module_enabled','pdv.module_enabled','kids.module_enabled','volunteers.module_enabled'].some(k=>input[k]===true),'intelligence.multicampus':!!base&&input['system.multicampus_enabled']===true};
 for(const [key,value]of Object.entries(values))if(result[key]===undefined)result[key]=value;return result;
}
module.exports={migrationId,additions,extend};
if(require.main===module){require('dotenv').config();const {createAdminConnection}=require('./scripts/db-admin.cjs');
 (async()=>{const db=await createAdminConnection();let locked=false;try{
 const checksum=crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
 const [lock]=await db.query("SELECT GET_LOCK('faith_hub_schema_migrations',30) AS acquired");locked=Number(lock[0].acquired)===1;if(!locked)throw Error('MIGRATION_LOCK_TIMEOUT');
 const [applied]=await db.query('SELECT checksum FROM schema_migrations WHERE migration_id = ?',[migrationId]);
 if(process.argv.includes('--status')){console.log(JSON.stringify({migrationId,applied:!!applied.length,checksumMatches:!applied.length||applied[0].checksum===checksum}));return;}
 if(applied.length){if(applied[0].checksum!==checksum)throw Error('MIGRATION_CHECKSUM_MISMATCH');console.log('ALREADY_APPLIED');return;}
 await db.beginTransaction();try{
 for(const [key,description]of Object.entries(additions))for(const [org,enabled,env]of [['global',0,'all'],['org_default',1,'production']]){
 const id='ff_ops_'+crypto.createHash('sha256').update(org+key).digest('hex').slice(0,26);
 await db.query(`INSERT INTO tenant_feature_flags(id,organization_id,campus_id,environment,feature_key,is_enabled,category,description,updated_by)
 VALUES(?,?,NULL,?,?,?,'Inteligência',?,'intelligence-operations-migration') ON DUPLICATE KEY UPDATE description=VALUES(description)`,[id,org,env,key,enabled,description]);}
 // saas_plans is the global commercial catalog, not tenant operational data.
 const [plans]=await db.query('SELECT id,entitlements FROM saas_plans WHERE entitlements IS NOT NULL');
 for(const plan of plans){const value=typeof plan.entitlements==='string'?JSON.parse(plan.entitlements):plan.entitlements;if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_PLAN_ENTITLEMENTS');await db.query('UPDATE saas_plans SET entitlements = ? WHERE id = ?',[JSON.stringify(extend(value)),plan.id]);}
 await db.query(`INSERT INTO security_audit_logs(id,organization_id,user_email,user_role,action,resource,resource_id,details,status)
 VALUES(UUID(),'org_default','system@faithhubs.com','SYSTEM','INTELLIGENCE_OPERATIONS_MIGRATION','schema_migrations',?,?,'SUCCESS')`,[migrationId,JSON.stringify({pilot:'org_default',chargesChanged:false,financialRecordsChanged:false})]);
 await db.query('INSERT INTO schema_migrations(migration_id,checksum) VALUES(?,?)',[migrationId,checksum]);await db.commit();
 }catch(e){await db.rollback();throw e;}console.log(JSON.stringify({migrationId,applied:true,pilot:'org_default',chargesChanged:false,financialRecordsChanged:false}));
 }finally{if(locked)await db.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");await db.end();}})().catch(e=>{console.error(e.message);process.exitCode=1;});}
