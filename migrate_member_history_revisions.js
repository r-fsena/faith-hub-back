const fs=require('node:fs'),crypto=require('node:crypto');
const schema=require('./scripts/member-history-revisions-schema.cjs');
const migrationId='20261117_001_member_history_revisions';
module.exports={migrationId,applySchema:schema.applySchema};
if(require.main===module){
 if(!process.argv.includes('--status')&&!process.argv.includes('--apply'))throw Error('USE --status ou --apply; migração exige autorização específica de publicação.');
 require('dotenv').config({quiet:true});
 (async()=>{
  const db=await require('./scripts/db-admin.cjs').createAdminConnection();let locked=false;
  try{
   const checksum=crypto.createHash('sha256').update(fs.readFileSync(__filename)).update(fs.readFileSync(require.resolve('./scripts/member-history-revisions-schema.cjs'))).digest('hex');
   const [applied]=await db.query('SELECT checksum FROM schema_migrations WHERE migration_id = ?',[migrationId]);
   if(process.argv.includes('--status')){console.log(JSON.stringify({migrationId,applied:!!applied.length,checksumMatches:!applied.length||applied[0].checksum===checksum,flagsAutomaticallyEnabled:false}));return;}
   const [lock]=await db.query("SELECT GET_LOCK('faith_hub_schema_migrations',30) AS acquired");locked=Number(lock[0].acquired)===1;if(!locked)throw Error('MIGRATION_LOCK_TIMEOUT');
   const [current]=await db.query('SELECT checksum FROM schema_migrations WHERE migration_id = ?',[migrationId]);
   if(current.length){if(current[0].checksum!==checksum)throw Error('MIGRATION_CHECKSUM_MISMATCH');console.log('ALREADY_APPLIED');return;}
   const [base]=await db.query('SELECT migration_id FROM schema_migrations WHERE migration_id = ?',['20261108_002_intelligence_foundations']);if(!base.length)throw Error('FOUNDATION_MIGRATION_REQUIRED');
   await schema.applySchema(db);
   await db.beginTransaction();try{
    await db.query(`INSERT IGNORE INTO tenant_feature_flags(id,organization_id,environment,feature_key,is_enabled,category,description,updated_by)
     VALUES('ff_history_corrections_v1','global','all','intelligence.history_corrections',0,'Inteligência','Revisão retroativa motivada do histórico de membros','history-revisions-migration')`);
    await db.query(`INSERT INTO security_audit_logs(id,organization_id,user_email,user_role,action,resource,resource_id,details,status)
     VALUES(UUID(),'global','system@faithhubs.com','SYSTEM','MEMBER_HISTORY_REVISIONS_MIGRATION','schema_migrations',?,?,'SUCCESS')`,[migrationId,JSON.stringify({flagsEnabled:0,observationsChanged:0,currentMembersChanged:0})]);
    await db.query('INSERT INTO schema_migrations(migration_id,checksum) VALUES(?,?)',[migrationId,checksum]);await db.commit();
   }catch(e){await db.rollback();throw e;}
   console.log(JSON.stringify({migrationId,applied:true,flagsEnabled:0,observationsChanged:0}));
  }finally{if(locked)await db.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");await db.end();}
 })().catch(e=>{console.error(e.message);process.exitCode=1;});
}
