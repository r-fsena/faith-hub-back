// Integration verification uses connection-local TEMPORARY tables only; no customer records are read or changed.
require('dotenv').config();process.env.AWS_EC2_METADATA_DISABLED='true';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const {createAdminConnection}=require('./db-admin.cjs');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
function mock(file,exports){const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports};}
let db;
let stage='connect';
(async()=>{
 if(!process.argv.includes('--temporary-only'))throw Error('Use --temporary-only to confirm the isolated integration mode.');
 db=await createAdminConnection();
 async function temporaryCopy(table,target=table){
  const [rows]=await db.query(`SHOW CREATE TABLE ${table}`);
  const ddl=rows[0]['Create Table'].split('\n').filter(line=>!/^\s*CONSTRAINT\s/.test(line)).join('\n')
    .replace(/^CREATE (?:TEMPORARY )?TABLE `[^`]+`/,`CREATE TEMPORARY TABLE \`${target}\``).replace(/,\n\)/g,'\n)');
  await db.query(ddl);
 }
 for(const table of ['members','campuses','cell_groups','cell_meetings','cell_meeting_attendees','church_visitors','content_engagement_events','devotionals','pastoral_care_logs','ministries','ministry_roles','service_schedules','service_roster_items','security_audit_logs','tenant_feature_flags']){
  stage='temporary schema: '+table;
  await temporaryCopy(table);
 }
 // MySQL temporary tables cannot be reopened with a second alias in a self-join.
 await temporaryCopy('members','intelligence_fixture_leaders');
 const migration=fs.readFileSync(path.join(__dirname,'../migrate_intelligence.js'),'utf8');
 const ddl=vm.runInNewContext('['+migration.match(/const tables = \[([\s\S]*?)\n\];/)[1]+']');
 for(const sql of ddl)await db.query(sql.replace('CREATE TABLE IF NOT EXISTS','CREATE TEMPORARY TABLE'));
 for(const sql of require('../migrate_intelligence_journeys.js').tables)await db.query(sql.replace('CREATE TABLE IF NOT EXISTS','CREATE TEMPORARY TABLE'));
 await db.query('CREATE TEMPORARY TABLE intelligence_fixture_return LIKE intelligence_activity_daily');
 await db.query('CREATE TEMPORARY TABLE intelligence_fixture_meetings LIKE cell_meetings');
 await db.query('CREATE TEMPORARY TABLE organizations(id VARCHAR(100) PRIMARY KEY)');
 mock('../src/db/index.ts',{query:async(sql,params)=>{const [rows]=await db.query(sql.replace('LEFT JOIN members leader','LEFT JOIN intelligence_fixture_leaders leader').replace('FROM intelligence_activity_daily r','FROM intelligence_fixture_return r').replace('FROM cell_meetings cm2','FROM intelligence_fixture_meetings cm2'),params);return{rows};},getConnection:async()=>({query:(sql,params)=>db.query(sql,params),beginTransaction:()=>db.beginTransaction(),commit:()=>db.commit(),rollback:()=>db.rollback(),release:()=>{}}),apiResponse:(statusCode,body)=>({statusCode,body:JSON.stringify(body)})});
 const flags={'intelligence.overview':true,'intelligence.usage_collection':true,'content.analytics_dashboard':true,'members.module_enabled':true,'cell_groups.module_enabled':true,'visitors.module_enabled':true,'ministries.module_enabled':true,'devotionals.module_enabled':true};
 mock('../src/services/featureFlagService.ts',{evaluateTenantFlags:async()=>({flags})});
 mock('../src/services/planAccess.ts',{enforcePlanAccess:async()=>null});
 const model=require('../src/services/intelligenceModel.ts'),usage=require('../src/services/intelligenceUsage.ts');
 const {intelligenceOverview}=require('../src/services/intelligenceOverview.ts');
 const {intelligenceScope}=require('../src/services/intelligenceScope.ts');
 const auth=require('../src/services/authMiddleware.ts');
 const org='org_int_fixture_a',other='org_int_fixture_b',campus='int_fixture_campus',person='int_fixture_member_0';
 stage='synthetic fixtures';
 const user={userId:person,email:'fixture@example.test',role:'ADMIN',organizationId:org,campusIds:[campus],isSuperAdmin:false,operationalPermissions:[]};
 auth.requireAuth=async()=>({user});
 await db.query('INSERT INTO organizations(id) VALUES (?),(?)',[org,other]);
 await db.query('INSERT INTO campuses(id,organization_id,name,status) VALUES(?,?,?,?)',[campus,org,'Synthetic campus','ACTIVE']);
 for(const owner of [org,other])for(let n=0;n<12;n++){
  const id=owner===org?`int_fixture_member_${n}`:`int_fixture_other_${n}`;
  await db.query(`INSERT INTO members(id,organization_id,campus_id,name,email,role,status,birth_date) VALUES(?,?,?,?,?,'MEMBER','ACTIVE','1990-04-15')`,[id,owner,campus,'Synthetic fixture',`${id}@example.test`]);
 }
 const request={headers:{'x-organization-id':org},queryStringParameters:{organization_id:org,campus_id:campus}};
 stage='consent';const consent=await usage.setUsagePreference(org,user,{allowed:true,expected_revision:0,policy_version:model.INTELLIGENCE_VERSION},request);
 const event={id:'fixture-event-a',name:'screen_view',module:'home',version:'v2',session_id:'fixture-session-a',occurred_at:new Date().toISOString()};
 const message={type:'PWA_USAGE_V1',organization_id:org,campus_id:campus,user_id:person,consent_revision:consent.revision,received_at:new Date().toISOString(),events:[event]};
 stage='worker';await usage.processUsage(message);await usage.processUsage(message);
 let [rows]=await db.query('SELECT SUM(interactions) AS interactions FROM intelligence_activity_daily WHERE organization_id = ?',[org]);assert.equal(Number(rows[0].interactions),1);
 const day=model.dayInSaoPaulo();
 await db.query("INSERT INTO devotionals(id,organization_id,campus_id,title,available_date,status) VALUES(?,?,?,'Synthetic fixture only',?,'PUBLISHED')",['int_fixture_devotional',org,campus,day]);
 const contentMessage={...message,events:[{...event,id:'fixture-content-a',name:'content_interaction',module:'devotionals',content_type:'DEVOTIONAL',content_id:'int_fixture_devotional',event_type:'OPENED'}]};
 await usage.processUsage(contentMessage);await usage.processUsage(contentMessage);
 [rows]=await db.query('SELECT COUNT(*) AS count FROM content_engagement_events WHERE organization_id = ?',[org]);assert.equal(Number(rows[0].count),1);
 for(const owner of [org,other])for(let n=1;n<12;n++){
  const id=owner===org?`int_fixture_member_${n}`:`int_fixture_other_${n}`;
  await db.query(`INSERT INTO intelligence_activity_daily(organization_id,campus_id,activity_date,subject_key,session_key,module,experience_version,actor_kind,cell_group_id,interactions,first_at,last_at)
   VALUES(?,?,?,?,?,'home','v2','member','',1,UTC_TIMESTAMP(),UTC_TIMESTAMP())`,[owner,campus,day,model.subjectKey(owner,id),String(n).padStart(64,'0')]);
 }
 const scope=await intelligenceScope(request,user);
 stage='overview';const overview=await intelligenceOverview(scope,flags,'month');
 assert.equal(overview.metrics.find(m=>m.key==='registered_members').value,12);
 assert.equal(overview.metrics.find(m=>m.key==='content_reach').status,'not_measured');
 assert.deepEqual(overview.quality.errors,[]);
 const {getMemberTimeline360}=require('../src/functions/pastoralCare.ts');
 stage='timeline';let result=await getMemberTimeline360({...request,pathParameters:{id:person}});assert.equal(result.statusCode,200);
 result=await getMemberTimeline360({...request,pathParameters:{id:'int_fixture_other_1'}});assert.equal(result.statusCode,404);
 await usage.setUsagePreference(org,user,{allowed:false,expected_revision:consent.revision,policy_version:model.INTELLIGENCE_VERSION},request);
 await usage.processUsage(message);
 [rows]=await db.query('SELECT COUNT(*) AS count FROM intelligence_activity_daily WHERE organization_id = ? AND subject_key = ?',[org,model.subjectKey(org,person)]);assert.equal(Number(rows[0].count),0);
 [rows]=await db.query('SELECT COUNT(*) AS count FROM content_engagement_events WHERE organization_id = ? AND user_id = ?',[org,person]);assert.equal(Number(rows[0].count),0);
 [rows]=await db.query('SELECT COUNT(*) AS count FROM intelligence_activity_daily WHERE organization_id = ?',[other]);assert.equal(Number(rows[0].count),11);
 const {maintainIntelligence}=require('../src/functions/intelligence.ts');
 await maintainIntelligence();
 [rows]=await db.query('SELECT SUM(active_members) AS total FROM intelligence_member_snapshots WHERE organization_id = ?',[org]);assert.equal(Number(rows[0].total),12);
 stage='journey integration';await require('./test-intelligence-journeys-mysql.cjs')({db,org,other,campus,person,user,scope,flags,model});
 console.log(JSON.stringify({temporaryTablesOnly:true,customerRecordsRead:false,customerRecordsChanged:false,checks:['DDL on deployed MySQL engine','consent transaction and audit','worker idempotency','legacy content bridge without double counting','overview SQL and tenant isolation','360 timeline SQL and cross-tenant denial','withdrawal and in-flight message rejection','scoped snapshot and retention']}));
})().catch(e=>{console.error(stage+': '+e.message);process.exitCode=1;}).finally(async()=>{if(db)await db.end();});
