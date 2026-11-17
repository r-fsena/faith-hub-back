// Local MySQL only. Never loads .env, AWS credentials or customer schema/data.
process.env.AWS_EC2_METADATA_DISABLED='true';
const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),mysql=require('mysql2/promise'),{randomUUID,randomBytes}=require('node:crypto');
if(!process.argv.includes('--local-only'))throw Error('LOCAL_ONLY_REQUIRED');
const connection={host:'127.0.0.1',port:33308,user:'root',password:'',dateStrings:true,timezone:'Z',connectTimeout:5000};
const name='faith_h1_qa_'+randomBytes(6).toString('hex');let db,created=false,checks=0,failAudit=false,memberLockWait;
const connections=new Set(),closing=[];const check=()=>checks++;
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const mock=(file,exports)=>{const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports};};
(async()=>{
 db=await mysql.createConnection(connection);assert.equal((await db.query('SELECT @@port AS port'))[0][0].port,33308);assert.match(name,/^faith_h1_qa_[0-9a-f]{12}$/);
 await db.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);created=true;await db.query(`USE \`${name}\``);
 const definitions=[
  'CREATE TABLE members(id VARCHAR(100),organization_id VARCHAR(100),status VARCHAR(100),role VARCHAR(100),campus_id VARCHAR(100),cell_group_id VARCHAR(100),PRIMARY KEY(organization_id,id)) ENGINE=InnoDB',
  'CREATE TABLE campuses(id VARCHAR(100),organization_id VARCHAR(100),name VARCHAR(100),PRIMARY KEY(organization_id,id)) ENGINE=InnoDB',
  'CREATE TABLE cell_groups(id VARCHAR(100),organization_id VARCHAR(100),name VARCHAR(100),campus_id VARCHAR(100),PRIMARY KEY(organization_id,id)) ENGINE=InnoDB',
  'CREATE TABLE tenant_feature_flags(id VARCHAR(100),organization_id VARCHAR(100),feature_key VARCHAR(100),campus_id VARCHAR(100),environment VARCHAR(40),is_enabled TINYINT,updated_at DATETIME(6),PRIMARY KEY(organization_id,id)) ENGINE=InnoDB',
  'CREATE TABLE cell_meeting_attendees(organization_id VARCHAR(100),meeting_id VARCHAR(100),member_id VARCHAR(100),status VARCHAR(20)) ENGINE=InnoDB',
  'CREATE TABLE security_audit_logs(id CHAR(36),organization_id VARCHAR(100),campus_id VARCHAR(100),user_id VARCHAR(100),user_email VARCHAR(255),user_role VARCHAR(40),action VARCHAR(100),resource VARCHAR(100),resource_id VARCHAR(100),details JSON,ip_address VARCHAR(100),user_agent VARCHAR(500),status VARCHAR(30)) ENGINE=InnoDB'
 ];
 for(const sql of definitions)await db.query(sql);
 const foundation=require('./foundation-schema.cjs');for(const sql of foundation.tables.filter(s=>/CREATE TABLE IF NOT EXISTS member_/.test(s)))await db.query(sql);
 const schema=require('./member-history-revisions-schema.cjs');await schema.applySchema(db);await schema.applySchema(db);for(const sql of foundation.triggers)await db.query(sql);check();
 const org='h1-org-a',other='h1-org-b',generation=randomUUID(),user={userId:'qa-admin',email:'qa@example.test',role:'ADMIN',organizationId:org,campusIds:['all'],isSuperAdmin:false,operationalPermissions:[]};
 const scope={user,organizationId:org,campusId:null,campusIds:null,cellIds:null},flags=Object.fromEntries(['intelligence.overview','intelligence.history','intelligence.history_corrections','members.module_enabled','cell_groups.module_enabled'].map(k=>[k,true]));
 const wrapped=async()=>{const c=await mysql.createConnection({...connection,database:name});connections.add(c);return {query:async(sql,p=[])=>{assert.equal((sql.match(/\?/g)||[]).length,p.length);if(failAudit&&sql.includes('INSERT INTO security_audit_logs'))throw Error('QA_AUDIT_FAIL');if(sql.includes('SELECT id FROM members')&&sql.includes('FOR UPDATE')&&memberLockWait){memberLockWait();memberLockWait=null;}return c.query(sql,p);},beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>{connections.delete(c);closing.push(c.end());}};};
 mock('../src/db/index.ts',{getConnection:wrapped,query:async(sql,p=[])=>({rows:(await db.query(sql,p))[0]}),apiResponse:(statusCode,body)=>({statusCode,body:JSON.stringify(body)})});
 mock('../src/services/featureFlagService.ts',{evaluateTenantFlags:async(o)=>({flags:o===org?flags:{}})});
 const corrections=require('../src/services/memberHistoryCorrections.ts'),history=require('../src/services/memberHistory.ts'),{occurrenceParticipation}=require('../src/services/intelligenceCalendar.ts'),{withIntelligencePeriod}=require('../src/services/intelligenceModel.ts');
 await db.query("INSERT INTO campuses VALUES('ca',?,'Synthetic A'),('cb',?,'Synthetic B')",[org,org]);
 await db.query("INSERT INTO cell_groups VALUES('cell-a',?,'Synthetic group','ca'),('foreign-cell',?,'Foreign synthetic group','ca')",[org,other]);
 await db.query("INSERT INTO tenant_feature_flags VALUES('flag-a',?,'intelligence.history',NULL,'production',1,'2026-11-01 00:00:00')",[org]);
 await db.query("INSERT INTO members VALUES('member-a',?,'ACTIVE','MEMBER','ca','cell-a')",[org]);
 await db.query("INSERT INTO member_history_coverage(organization_id,generation,flag_id,flag_updated_at,started_at,created_at) VALUES(?,?,'flag-a','2026-11-01 00:00:00','2026-11-01 00:00:00','2026-11-01 00:00:00')",[org,generation]);
 const ids=[randomUUID(),randomUUID(),randomUUID()];
 for(const [i,status,previous,day]of [[0,'ACTIVE',null,'01'],[1,'INACTIVE','ACTIVE','10'],[2,'ACTIVE','INACTIVE','12']])await db.query(`INSERT INTO member_state_history(id,organization_id,generation,member_id,kind,before_status,after_status,before_role,after_role,before_campus_id,after_campus_id,before_cell_id,after_cell_id,source,occurred_at)
  VALUES(?,?,?,'member-a',?,?,?,?,? ,?,'ca',?,'cell-a','QA',?)`,[ids[i],org,generation,i===0?'BASELINE':'CHANGED',previous,status,i===0?null:'MEMBER','MEMBER',i===0?null:'ca',i===0?null:'cell-a',`2026-11-${day} 00:00:00`]);
 // Same event reference in another tenant must never receive A's correction.
 await db.query(`INSERT INTO member_state_history(id,organization_id,generation,member_id,kind,after_status,after_role,after_campus_id,source,occurred_at) VALUES(?,?,?,'member-b','BASELINE','ACTIVE','MEMBER','ca','QA','2026-11-01 00:00:00')`,[ids[1],other,randomUUID()]);
 await db.query("INSERT INTO cell_meeting_attendees VALUES(?,'meeting-a','member-a','PRESENT')",[org]);
 const occurrence={status:'HELD',attendance_confirmed:1,starts_at:'2026-11-06 12:00:00',created_at:'2026-11-02T12:00:00Z',meeting_id:'meeting-a',campus_id:'ca',cell_group_id:'cell-a'};
 const period={preset:'7d',start:'2026-11-04',end:'2026-11-07',previousStart:'2026-11-01',previousEnd:'2026-11-04',timezone:'America/Sao_Paulo',comparison:'QA'};
 const read=()=>withIntelligencePeriod(period,()=>history.memberHistory(scope,'7d'));
 let data=await read();assert.equal(data.snapshots.current,1);assert.equal(data.counts.status_changes,0);assert.equal((await occurrenceParticipation(scope,occurrence)).eligible,1);check();
 const body={request_id:randomUUID(),generation,expected_version:0,expected_revision:0,effective_at:'2026-11-05T00:00:00.000Z',after_status:'INACTIVE',after_campus_id:'ca',after_cell_id:'cell-a',reason:'Synthetic corrected effective date.'};
 assert.equal((await corrections.correctMemberHistory(scope,ids[1],body,{})).revision,1);assert.equal((await corrections.correctMemberHistory(scope,ids[1],body,{})).recorded,false);check();
 data=await read();assert.equal(data.revision,1);assert.equal(data.snapshots.current,0);assert.equal(data.snapshots.previous,1);assert.equal(data.counts.status_changes,1);check();
 let participation=await occurrenceParticipation(scope,occurrence);assert.equal(participation.eligible,0);assert.equal(participation.present,0);assert.equal(participation.participation_percent,null);assert.equal(participation.history_revision,1);check();
 mock('../src/services/intelligenceOverview.ts',{intelligenceOverview:async()=>({metrics:[],quality:{notes:[],errors:[]}})});
 const {collectReportData}=require('../src/services/intelligenceReportData.ts'),{reportCsv,reportPdf}=require('../src/services/intelligenceReportFiles.ts');
 const firstReport=await collectReportData(scope,flags,'executive',period,'Synthetic church'),firstCsv=reportCsv(firstReport).toString('utf8');
 assert.equal(firstReport.rows.find(r=>r.metric==='Membros ativos no fechamento').current,0);assert.ok(firstCsv.includes('Revisão histórica 1'));check();
 assert.equal((await reportPdf(firstReport)).subarray(0,4).toString(),'%PDF');
 let [rows]=await db.query('SELECT after_status,occurred_at FROM member_state_history WHERE organization_id = ? AND id = ?',[org,ids[1]]);assert.equal(rows[0].after_status,'INACTIVE');assert.equal(rows[0].occurred_at,'2026-11-10 00:00:00.000000');
 [rows]=await db.query('SELECT after_status,correction_version FROM member_state_history_effective WHERE organization_id = ? AND id = ?',[other,ids[1]]);assert.equal(rows[0].after_status,'ACTIVE');assert.equal(rows[0].correction_version,0);check();
 const correctedState={...body,request_id:randomUUID(),expected_version:1,expected_revision:1,after_status:'ACTIVE'};
 await corrections.correctMemberHistory(scope,ids[1],correctedState,{});
 [rows]=await db.query('SELECT before_status FROM member_state_history_effective WHERE organization_id = ? AND id = ?',[org,ids[2]]);assert.equal(rows[0].before_status,'ACTIVE');
 [rows]=await db.query('SELECT before_status FROM member_state_history WHERE organization_id = ? AND id = ?',[org,ids[2]]);assert.equal(rows[0].before_status,'INACTIVE');check();
 data=await read();assert.equal(data.snapshots.current,1);assert.equal(data.counts.status_changes,0);participation=await occurrenceParticipation(scope,occurrence);assert.equal(participation.eligible,1);assert.equal(participation.participation_percent,100);check();
 const revisedReport=await collectReportData(scope,flags,'executive',period,'Synthetic church');assert.equal(revisedReport.rows.find(r=>r.metric==='Membros ativos no fechamento').current,1);assert.notEqual(revisedReport.revision,firstReport.revision);assert.ok(revisedReport.notes.some(n=>n.includes('revisão 2')));assert.equal(reportCsv(firstReport).toString('utf8'),firstCsv);check();
 const detail=await corrections.historyCorrectionDetails(scope,ids[1]);assert.equal(detail.revisions.length,2);assert.equal(detail.original.after_status,'INACTIVE');assert.equal(detail.event.after_status,'ACTIVE');check();
 await assert.rejects(corrections.correctMemberHistory(scope,ids[1],{...body,request_id:randomUUID(),expected_version:2,expected_revision:2,after_cell_id:'foreign-cell'},{}),e=>e.status===400);check();
 failAudit=true;await assert.rejects(corrections.correctMemberHistory(scope,ids[1],{...body,request_id:randomUUID(),expected_version:2,expected_revision:2},{}),/QA_AUDIT_FAIL/);failAudit=false;
 assert.equal((await corrections.memberHistoryRevision(org)).revision,2);assert.equal((await corrections.historyCorrectionDetails(scope,ids[1])).revisions.length,2);check();
 const concurrent=await Promise.allSettled([1,2].map(n=>corrections.correctMemberHistory(scope,ids[1],{...body,request_id:randomUUID(),expected_version:2,expected_revision:2,reason:`Synthetic concurrent correction ${n}.`},{})));
 assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);assert.equal(concurrent.find(r=>r.status==='rejected').reason.status,409);assert.equal((await corrections.memberHistoryRevision(org)).revision,3);check();
 // An ordinary write holding the member lock must become visible before the
 // correction validates its timeline (READ COMMITTED, not an earlier snapshot).
 const holding=await mysql.createConnection({...connection,database:name});await holding.beginTransaction();await holding.query('SELECT id FROM members WHERE organization_id = ? AND id = ? FOR UPDATE',[org,'member-a']);
 let waiting;const reached=new Promise(resolve=>{memberLockWait=resolve;});
 try{
  waiting=corrections.correctMemberHistory(scope,ids[1],{...correctedState,request_id:randomUUID(),expected_version:3,expected_revision:3},{});
  void waiting.catch(()=>{});
  await Promise.race([reached,new Promise((_,reject)=>setTimeout(()=>reject(Error('MEMBER_LOCK_TIMEOUT')),5000))]);
  await holding.query("UPDATE members SET status='PENDING' WHERE organization_id = ? AND id = ?",[org,'member-a']);await holding.commit();assert.equal((await waiting).revision,4);
 }finally{await holding.rollback();await holding.end();}check();
 [rows]=await db.query('SELECT status FROM members WHERE organization_id = ? AND id = ?',[org,'member-a']);assert.equal(rows[0].status,'PENDING');
 [rows]=await db.query("SELECT COUNT(*) AS n FROM security_audit_logs WHERE organization_id = ? AND action='CORRECT_MEMBER_HISTORY'",[org]);assert.equal(rows[0].n,4);check();
 // Initialization's flag-first lock must fail the correction promptly rather
 // than forming a member/flag lock cycle.
 const baselineLock=await mysql.createConnection({...connection,database:name});await baselineLock.beginTransaction();
 try{await baselineLock.query('SELECT id FROM tenant_feature_flags WHERE organization_id = ? FOR UPDATE',[org]);await assert.rejects(corrections.correctMemberHistory(scope,ids[1],{...body,request_id:randomUUID(),expected_version:4,expected_revision:4},{}),e=>e.status===409);assert.equal((await corrections.memberHistoryRevision(org)).revision,4);}finally{await baselineLock.rollback();await baselineLock.end();}check();
 // Revoking/renewing coverage preserves old corrections, but cannot revise a
 // previous generation using the new baseline.
 await db.query("UPDATE tenant_feature_flags SET is_enabled=0,updated_at=UTC_TIMESTAMP(6) WHERE organization_id = ? AND id='flag-a'",[org]);
 await assert.rejects(corrections.correctMemberHistory(scope,ids[1],{...body,request_id:randomUUID(),expected_version:4,expected_revision:4},{}),e=>e.status===409);check();
 await db.query("UPDATE tenant_feature_flags SET is_enabled=1,updated_at=UTC_TIMESTAMP(6) WHERE organization_id = ? AND id='flag-a'",[org]);
 await db.beginTransaction();await foundation.initializeHistoryBaseline(db,org,user.userId);await db.commit();
 await assert.rejects(corrections.correctMemberHistory(scope,ids[1],{...body,request_id:randomUUID(),expected_version:4,expected_revision:4},{}),e=>e.status===409);
 assert.equal((await corrections.historyCorrectionDetails(scope,ids[1])).correction_allowed,false);check();
 assert.equal(connections.size,0);await Promise.all(closing);console.log(JSON.stringify({result:'PASS',checks,engine:(await db.query('SELECT VERSION() AS v'))[0][0].v,host:'127.0.0.1',port:33308,disposableSchema:true,customerRecordsRead:0,customerRecordsChanged:0}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{for(const c of connections)await c.end();await Promise.all(closing);if(db){try{if(created&&/^faith_h1_qa_[0-9a-f]{12}$/.test(name)){await db.query(`DROP DATABASE \`${name}\``);console.log('QA_SCHEMA_REMOVED');}}finally{await db.end();}}});
