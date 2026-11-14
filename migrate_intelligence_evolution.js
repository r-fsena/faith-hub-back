// Additive release. Never edit the already-published foundation migration.
const fs=require('node:fs'),crypto=require('node:crypto');
const files=['financial-evolution-schema','report-schema','calendar-schema','capacity-schema','alert-schema'];
const schemas=files.map(f=>require('./scripts/'+f+'.cjs'));
const migrationId='20261113_003_intelligence_evolution';
const additions={'financial.transfers_reversals':'Transferências, correções e devoluções','intelligence.reports':'Relatórios privados PDF e CSV','intelligence.calendar':'Agenda e participação verificável','intelligence.capacities':'Capacidades e vagas versionadas','intelligence.alerts':'Alertas e acompanhamento por unidade'};
function extend(v){const r={...v},base=v['intelligence.overview']??v['content.analytics_dashboard']===true;const inferred={'financial.transfers_reversals':v['financial.accounts_ledger']??(v['financial.module_enabled']===true&&v['financial.cashflow_ledger']===true),'intelligence.reports':!!base,'intelligence.calendar':!!base&&v['intelligence.history']!==false&&v['members.module_enabled']===true&&v['cell_groups.module_enabled']===true,'intelligence.capacities':!!base&&v['intelligence.operations']!==false&&['events.module_enabled','kids.module_enabled','volunteers.module_enabled'].some(k=>v[k]===true),'intelligence.alerts':v['intelligence.actions']??!!base};for(const k of Object.keys(additions))if(r[k]===undefined)r[k]=inferred[k];return r;}
async function applySchema(db){
 for(const s of schemas)for(const sql of s.tables)await db.query(sql);
 for(const [table,cols]of Object.entries(schemas[3].columns))for(const [name,type]of Object.entries(cols)){const [found]=await db.query('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',[table,name]);if(!found.length)await db.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);}
 // Only tenant identity is backfilled, never a historical capacity or attendance estimate.
 const [orgs]=await db.query('SELECT id FROM organizations ORDER BY id');
 for(const o of orgs)await db.query('UPDATE event_lots l INNER JOIN events e ON e.id=l.event_id SET l.organization_id=e.organization_id WHERE e.organization_id = ? AND l.organization_id IS NULL',[o.id]);
 await db.query(schemas[0].reportingView);
 for(const s of schemas)for(const sql of s.triggers||[]){const name=sql.match(/^CREATE TRIGGER (\w+)/)[1];const [found]=await db.query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=?',[name]);if(!found.length)await db.query(sql);}
}
module.exports={migrationId,additions,extend,applySchema};
if(require.main===module){require('dotenv').config({quiet:true});const {createAdminConnection}=require('./scripts/db-admin.cjs');(async()=>{const db=await createAdminConnection();let locked=false;try{
 const checksum=crypto.createHash('sha256').update(fs.readFileSync(__filename));for(const file of files)checksum.update(fs.readFileSync(require.resolve('./scripts/'+file+'.cjs')));checksum.update(fs.readFileSync(require.resolve('./scripts/foundation-schema.cjs')));const sum=checksum.digest('hex');
 const [lock]=await db.query("SELECT GET_LOCK('faith_hub_schema_migrations',30) AS acquired");locked=Number(lock[0].acquired)===1;if(!locked)throw Error('MIGRATION_LOCK_TIMEOUT');
 const [applied]=await db.query('SELECT checksum FROM schema_migrations WHERE migration_id = ?',[migrationId]);const [settings]=await db.query('SELECT @@log_bin AS binlog_enabled,@@log_bin_trust_function_creators AS trust_creators,@@binlog_format AS binlog_format');const ready=!Number(settings[0].binlog_enabled)||!!Number(settings[0].trust_creators)&&settings[0].binlog_format==='ROW';
 if(process.argv.includes('--status')){console.log(JSON.stringify({migrationId,applied:!!applied.length,checksumMatches:!applied.length||applied[0].checksum===sum,triggerPrerequisiteReady:ready,pilotAutomaticallyEnabled:false}));return;}
 if(!process.argv.includes('--apply')&&!process.argv.includes('--schema-only'))throw Error('USE --status, --schema-only ou --apply; revisão de publicação obrigatória.');
 if(applied.length){if(applied[0].checksum!==sum)throw Error('MIGRATION_CHECKSUM_MISMATCH');console.log('ALREADY_APPLIED');return;}if(!ready)throw Error('TRIGGER_PREREQUISITE_NOT_READY');
 const [base]=await db.query('SELECT migration_id FROM schema_migrations WHERE migration_id = ?',['20261108_002_intelligence_foundations']);if(!base.length)throw Error('FOUNDATION_MIGRATION_REQUIRED');
 await applySchema(db);if(process.argv.includes('--schema-only')){console.log(JSON.stringify({migrationId,schemaReady:true,flagsChanged:false}));return;}
 await db.beginTransaction();try{
 for(const [key,description]of Object.entries(additions)){const id='ff_evo_'+crypto.createHash('sha256').update(key).digest('hex').slice(0,24);await db.query("INSERT IGNORE INTO tenant_feature_flags(id,organization_id,environment,feature_key,is_enabled,category,description,updated_by) VALUES(?,'global','all',?,0,'Inteligência',?,'evolution-migration')",[id,key,description]);}
 const [plans]=await db.query('SELECT id,entitlements FROM saas_plans WHERE entitlements IS NOT NULL');for(const p of plans){const v=typeof p.entitlements==='string'?JSON.parse(p.entitlements):p.entitlements;if(!v||Array.isArray(v)||typeof v!=='object')throw Error('INVALID_PLAN_ENTITLEMENTS');await db.query('UPDATE saas_plans SET entitlements=? WHERE id=?',[JSON.stringify(extend(v)),p.id]);}
 await db.query('INSERT INTO schema_migrations(migration_id,checksum) VALUES(?,?)',[migrationId,sum]);await db.commit();}catch(e){await db.rollback();throw e;}
 console.log(JSON.stringify({migrationId,applied:true,flagsEnabled:0,customerAmountsChanged:false,retrospectiveDataInvented:false}));
 }finally{if(locked)await db.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");await db.end();}})().catch(e=>{console.error(e.message);process.exitCode=1;});}
