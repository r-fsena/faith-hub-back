process.env.AWS_EC2_METADATA_DISABLED='true';
const {test,beforeEach}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),{randomUUID}=require('node:crypto');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const mock=(file,exports)=>{const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports};};let s;
mock('../src/db/index.ts',{query:async(sql,p)=>({rows:(await s.db.query(sql,p))[0]}),getConnection:async()=>{s.opened++;return s.db;},apiResponse:(statusCode,body)=>({statusCode,body:JSON.stringify(body)})});
mock('../src/services/featureFlagService.ts',{evaluateTenantFlags:async(org,campus)=>({flags:org==='org-a'&&campus!==s.disabledCampus?s.flags:{}})});
mock('../src/services/rateLimiter.ts',{checkRateLimit:async()=>({allowed:true})});
mock('../src/services/auditLogService.ts',{logSecurityEvent:async e=>{s.audit.push(e);assert.equal(e.strict,true);assert.equal(typeof e.executor,'function');if(s.failAudit)throw Error('AUDIT_FAILED');}});
const auth=require('../src/services/authMiddleware.ts');auth.requireAuth=async()=>s.user?{user:s.user}:{errorResponse:{statusCode:401,body:'{}'}};
const {historyInstant,correctMemberHistory,historyCorrectionDetails,correctionInput}=require('../src/services/memberHistoryCorrections.ts');
const {intelligenceHandler}=require('../src/functions/intelligence.ts');
const scope=()=>({user:s.user,organizationId:'org-a',campusId:null,campusIds:null,cellIds:null});
const request=(body=s.body,extra={})=>({httpMethod:'POST',path:'/intelligence/history/history-a/corrections',headers:{'x-organization-id':'org-a'},body:JSON.stringify(body),...extra});
beforeEach(()=>{
 const generation=randomUUID();s={opened:0,calls:[],steps:[],audit:[],revision:0,retry:null,user:{userId:'admin-a',role:'ADMIN',organizationId:'org-a',campusIds:['all'],isSuperAdmin:false,operationalPermissions:[]},flags:Object.fromEntries(['intelligence.overview','intelligence.history','intelligence.history_corrections','members.module_enabled','cell_groups.module_enabled'].map(k=>[k,true]))};
 s.h={id:'history-a',member_id:'member-a',kind:'CHANGED',generation,sequence_id:2,correction_version:0,occurred_at:'2026-11-10T12:00:00.000000Z',observed_at:'2026-11-10T12:00:00.000000Z',before_status:'ACTIVE',after_status:'INACTIVE',before_campus_id:'ca',after_campus_id:'ca',before_cell_id:null,after_cell_id:null,after_role:'MEMBER'};
 s.coverage={generation,started_at:'2026-11-01T00:00:00.000000Z'};
 s.neighbors=[{id:'baseline',sequence_id:1,occurred_at:s.coverage.started_at},{id:'next',sequence_id:3,occurred_at:'2026-11-11T12:00:00.000000Z'}];
 s.body={request_id:randomUUID(),generation,expected_version:0,expected_revision:0,effective_at:'2026-11-05T12:00:00.000Z',after_status:'INACTIVE',after_campus_id:'ca',after_cell_id:null,reason:'Data conferida no registro original.'};
 s.db={beginTransaction:async()=>s.steps.push('begin'),commit:async()=>s.steps.push('commit'),rollback:async()=>s.steps.push('rollback'),release:()=>s.steps.push('release'),query:async(sql,p=[])=>{
  s.calls.push({sql,p});assert.equal((sql.match(/\?/g)||[]).length,p.length,sql);
  if(/FROM member_state_history_effective h/.test(sql))return [s.missing?[]:[{...s.h}]];
  if(/FROM member_state_history_effective\s/.test(sql))return [s.neighbors];
  if(/FROM member_state_history h/.test(sql))return [[s.h]];
  if(sql.includes('SELECT member_id FROM member_state_history'))return [s.missing?[]:[{member_id:s.h.member_id}]];
  if(sql.includes('FROM member_history_coverage'))return [s.coverage?[s.coverage]:[]];
  if(sql.includes('FROM tenant_feature_flags'))return [[{id:'flag-a'}]];
  if(sql.includes('FROM member_history_corrections'))return [s.retry?[s.retry]:[]];
  if(sql.includes('FROM member_history_revision_state'))return [[{revision:s.revision,revised_at:null}]];
  if(sql.includes('FROM cell_groups'))return [s.foreignCell?[]:[{id:'cell-a',campus_id:'ca',name:'Grupo A'}]];
  if(sql.includes('FROM campuses'))return [s.foreignCampus?[]:[{id:'ca',name:'Unidade A'}]];
  return [{affectedRows:1}];
 }};
});
const rejects=async(status,body=s.body,sc=scope())=>assert.rejects(correctMemberHistory(sc,'history-a',body,{}),e=>e.status===status);
test('strict timestamps preserve microseconds and reject rollover, missing offsets and impossible dates',()=>{
 assert.equal(historyInstant('2026-11-05T12:00:00.123Z'),'2026-11-05T12:00:00.123000Z');assert.equal(historyInstant('2026-11-05T12:00:00.123456Z'),'2026-11-05T12:00:00.123456Z');
 for(const v of ['2026-02-30T12:00:00.000Z','2026-11-05T24:00:00.000Z','2026-11-05T12:00:00','bad',null])assert.throws(()=>historyInstant(v));
});
test('correction commits one append-only revision and a strict audit without changing observations, members or permissions',async()=>{
 assert.deepEqual(await correctMemberHistory(scope(),'history-a',s.body,{}),{recorded:true,revision:1,event_version:1});
 assert.equal(s.steps.join(','),'begin,commit,release');assert.equal(s.audit[0].action,'CORRECT_MEMBER_HISTORY');assert.equal(s.audit[0].details.original_preserved,true);assert.equal(s.audit[0].details.current_member_changed,false);
 const mutations=s.calls.filter(c=>/^(INSERT|UPDATE|DELETE)/.test(c.sql));assert.ok(mutations.every(c=>/member_history_(corrections|revision_state)/.test(c.sql)));
 for(const c of s.calls.filter(c=>/^(SELECT|UPDATE|INSERT)/.test(c.sql)))assert.ok(c.sql.includes('organization_id'),c.sql);
 const insert=mutations.find(c=>c.sql.startsWith('INSERT INTO member_history_corrections'));assert.equal(insert.p[0],'org-a');assert.ok(insert.p.includes('2026-11-05 12:00:00.000000'));
 assert.ok(s.calls.findIndex(c=>c.sql.includes('FROM members')&&c.sql.includes('FOR UPDATE'))<s.calls.findIndex(c=>c.sql.includes('FROM member_state_history_effective h')));
});
test('authentication, tenant isolation, roles, units and flags reject requests before a transaction',async()=>{
 s.user=null;assert.equal((await intelligenceHandler(request())).statusCode,401);
 s.user={userId:'a',organizationId:'org-a',campusIds:['all'],role:'ADMIN',isSuperAdmin:false};
 assert.equal((await intelligenceHandler(request({...s.body,organization_id:'org-b'}))).statusCode,403);
 for(const role of ['MEMBER','VOLUNTEER','TREASURER','LEADER']){s.user.role=role;assert.equal((await intelligenceHandler(request())).statusCode,403);}
 s.user.role='ADMIN';await rejects(403,s.body,{...scope(),campusIds:['ca']});
 for(const key of ['intelligence.overview','intelligence.history','intelligence.history_corrections','members.module_enabled']){s.flags[key]=false;await rejects(403);s.flags[key]=true;}
 assert.equal(s.opened,0);
});
test('foreign history is not found and produces no correction',async()=>{s.missing=true;await rejects(404);assert.ok(!s.calls.some(c=>c.sql.startsWith('INSERT')));});
test('missing justification, malformed references, roles-as-status and invalid versions fail before opening the database',async()=>{
 for(const patch of [{reason:'curto'},{reason:'a'.repeat(501)},{reason:'texto\nprivado'},{request_id:'a'},{generation:'a'},{expected_version:-1},{expected_revision:1.5},{after_status:'SUPERADMIN'},{after_cell_id:'../../x'}])await rejects(400,{...s.body,...patch});assert.equal(s.opened,0);
});
test('baseline, gaps, earlier generations, stale event versions and stale indicator revisions cannot be changed',async()=>{
 s.h.kind='BASELINE';await rejects(409);s.h.kind='CHANGED';
 s.coverage=null;await rejects(409);s.coverage={generation:randomUUID(),started_at:'2026-11-01T00:00:00.000000Z'};await rejects(409);
 s.coverage.generation=s.h.generation;s.h.correction_version=1;await rejects(409);s.h.correction_version=0;s.revision=1;await rejects(409);
 assert.ok(!s.calls.some(c=>c.sql.startsWith('INSERT INTO member_history_corrections')));
});
test('a retroactive date cannot invent precoverage history, follow observation, or reorder adjacent facts',async()=>{
 for(const effective_at of ['2026-10-31T23:00:00.000Z','2026-11-10T12:00:00.001Z'])await rejects(400,{...s.body,effective_at});
 s.neighbors[0].occurred_at='2026-11-06T12:00:00.000000Z';await rejects(409);
 s.neighbors[0].occurred_at='2026-11-01T00:00:00.000000Z';s.neighbors[1].occurred_at='2026-11-04T12:00:00.000000Z';await rejects(409);
});
test('the last observed state remains aligned with the current member; only its date can change',async()=>{
 s.neighbors=s.neighbors.slice(0,1);await rejects(409,{...s.body,after_status:'ACTIVE'});
 assert.equal((await correctMemberHistory(scope(),'history-a',s.body,{})).recorded,true);
});
test('cross-tenant campus/cell references and disabled source units are refused',async()=>{
 s.foreignCampus=true;await rejects(400,{...s.body,after_campus_id:'foreign-campus'});s.foreignCampus=false;s.foreignCell=true;await rejects(400,{...s.body,after_cell_id:'foreign-cell'});await rejects(400,{...s.body,after_campus_id:null});
 s.disabledCampus='ca';await rejects(403);assert.ok(!s.calls.some(c=>c.sql.startsWith('INSERT INTO member_history_corrections')));
});
test('nullable legacy campus and removal timestamps can be revised without manufacturing a state',async()=>{
 s.h.after_campus_id=null;assert.equal((await correctMemberHistory(scope(),'history-a',{...s.body,after_campus_id:null},{})).recorded,true);
 s.h.kind='REMOVED';s.h.after_status=null;s.h.after_cell_id=null;await rejects(400,{...s.body,after_status:'ACTIVE'});
 assert.equal((await correctMemberHistory(scope(),'history-a',{...s.body,after_status:null,after_campus_id:null},{})).recorded,true);
});
test('retries replay the committed revision; changed content under the same request conflicts',async()=>{
 s.retry={request_hash:correctionInput('history-a',s.body,s.user.userId).hash,revision:7,event_version:2};
 assert.deepEqual(await correctMemberHistory(scope(),'history-a',s.body,{}),{recorded:false,revision:7,event_version:2});assert.equal(s.audit.length,0);
 await rejects(409,{...s.body,reason:'Outra justificativa com dados diferentes.'});assert.ok(!s.calls.some(c=>c.sql.startsWith('INSERT INTO member_history_corrections')));
});
test('strict audit failure rolls back both correction and indicator revision',async()=>{s.failAudit=true;await assert.rejects(correctMemberHistory(scope(),'history-a',s.body,{}),/AUDIT_FAILED/);assert.equal(s.steps.join(','),'begin,rollback,release');});
test('review exposes original and prior versions only to full-scope authorized administrators',async()=>{
 const detail=await historyCorrectionDetails(scope(),'history-a');assert.equal(detail.original.id,s.h.id);assert.equal(detail.correction_allowed,true);assert.equal(detail.revision,0);
 await assert.rejects(historyCorrectionDetails({...scope(),cellIds:['cell-a']},'history-a'),e=>e.status===403);
 s.coverage=null;assert.equal((await historyCorrectionDetails(scope(),'history-a')).correction_allowed,false);
});
test('additive commercial entitlement respects history denials and never changes prices',()=>{
 const {normalizeEntitlements,COMMERCIAL_CATALOG}=require('../src/services/planCatalog.ts');const old={...COMMERCIAL_CATALOG.plans[0].entitlements};delete old['intelligence.history_corrections'];
 assert.equal(normalizeEntitlements(old)['intelligence.history_corrections'],true);assert.equal(normalizeEntitlements({...old,'intelligence.history':false})['intelligence.history_corrections'],false);assert.equal(normalizeEntitlements({...old,'intelligence.history_corrections':false})['intelligence.history_corrections'],false);
});
