process.env.AWS_EC2_METADATA_DISABLED='true';
const {test,beforeEach}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const model=require('../src/services/intelligenceModel.ts');
let state,snapshot;
function mock(file,exports){const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports};}
async function execute(sql,params=[]){
  assert.equal((sql.match(/\?/g)||[]).length,params.length,sql);
  state.calls.push({sql,params});
  if(sql.includes('security_audit_logs')&&state.auditFail)throw Error('AUDIT_FAILURE');
  if(sql.includes('FROM campuses'))return state.campusExists?[{id:'campus-a'}]:[];
  if(sql.includes('FROM cell_groups'))return [{id:'cell-owned'}];
  if(sql.includes('FROM members m')&&sql.includes('LEFT JOIN intelligence_consent'))return [{birth_date:state.birth,...state.data.consent}];
  if(sql.includes('FROM members')&&sql.includes('birth_date'))return [{birth_date:state.birth,role:'MEMBER',status:'ACTIVE',cell_group_id:'cell-owned',campus_id:'campus-a',campus_ids:['campus-a']}];
  if(sql.includes('FROM intelligence_consent'))return state.data.consent?[{...state.data.consent,consent_time:new Date(state.data.consent.updated_at).getTime()}]:[];
  if(sql.includes('INSERT IGNORE INTO intelligence_consent')){if(!state.data.consent)state.data.consent={allowed:0,revision:0,policy_version:model.INTELLIGENCE_VERSION,updated_at:'2020-01-01T00:00:00Z'};return {affectedRows:1};}
  if(sql.startsWith('UPDATE intelligence_consent')){state.data.consent.allowed=params[0];state.data.consent.revision++;return {affectedRows:1};}
  if(sql.includes('INSERT IGNORE INTO intelligence_event_receipts')){const key=params[0]+':'+params[1],fresh=!state.data.receipts.has(key);state.data.receipts.add(key);return {affectedRows:fresh?1:0};}
  if(sql.includes('INSERT INTO intelligence_activity_daily')){state.data.interactions++;return {affectedRows:1};}
  if(sql.includes('DELETE FROM intelligence_activity_daily')){state.data.interactions=0;return {affectedRows:1};}
  if(sql.includes('DELETE FROM intelligence_event_receipts')){state.data.receipts.clear();return {affectedRows:1};}
  if(sql.includes('FROM intelligence_measurement'))return [{started_at:state.started,last_event_at:state.started,last_processed_at:state.started}];
  if(sql.includes('MIN(e.occurred_at)'))return [{first_event:state.started}];
  if(sql.includes('FROM intelligence_activity_daily')&&sql.includes('GROUP BY'))return [];
  if(sql.includes('FROM intelligence_activity_daily'))return [{current_value:state.people,previous_value:15,started_at:state.started}];
  if(sql.includes('FROM members m')&&sql.includes('COUNT'))return [{total:20,eligible:20,authorized:15}];
  if(sql.includes('FROM cell_meeting_attendees')||sql.includes('FROM cell_meetings')||sql.includes('FROM church_visitors')||sql.includes('FROM content_engagement_events'))return [{current_value:20,previous_value:10,waiting:2}];
  if(sql.includes('FROM members m')&&sql.includes('WHERE m.id'))return state.memberExists?[{id:'person',name:'Synthetic',organization_id:'org-a'}]:[];
  if(/^\s*(INSERT|UPDATE|DELETE)/.test(sql))return {affectedRows:1};
  if(sql.includes('FROM pastoral_care_logs')||sql.includes('FROM service_roster_items'))return [];
  throw Error('Unexpected query: '+sql);
}
mock('../src/db/index.ts',{apiResponse:(statusCode,body,headers)=>({statusCode,body:JSON.stringify(body),headers}),query:async(s,p)=>({rows:await execute(s,p)}),getConnection:async()=>({
  beginTransaction:async()=>{snapshot=structuredClone(state.data);},query:async(s,p)=>[await execute(s,p)],commit:async()=>{state.commits++;},rollback:async()=>{state.data=snapshot;state.rollbacks++;},release:()=>{},
})});
mock('../src/services/featureFlagService.ts',{evaluateTenantFlags:async()=>({flags:state.flags})});
mock('../src/services/rateLimiter.ts',{checkRateLimit:async()=>({allowed:state.rate,errorResponse:{statusCode:429,body:'{}'}})});
mock('../src/services/planAccess.ts',{enforcePlanAccess:async()=>null});
mock('../src/functions/contentAnalytics.ts',{contentExists:async()=>({exists:state.owned,campusId:state.contentCampus})});
mock('@aws-sdk/client-sqs',{SQSClient:class{async send(input){state.queued.push(JSON.parse(input.input.MessageBody));}},SendMessageCommand:class{constructor(input){this.input=input;}}});
const auth=require('../src/services/authMiddleware.ts');
auth.requireAuth=async()=>state.user?{user:state.user}:{errorResponse:{statusCode:401,body:'{}'}};
const {intelligenceHandler:handler,intelligenceWorker}=require('../src/functions/intelligence.ts');
const {intelligenceScope,scopedWhere}=require('../src/services/intelligenceScope.ts');
const usage=require('../src/services/intelligenceUsage.ts');
const {getMemberTimeline360}=require('../src/functions/pastoralCare.ts');
const user={userId:'user-a',email:'synthetic@example.test',role:'ADMIN',organizationId:'org-a',campusIds:['campus-a'],isSuperAdmin:false,operationalPermissions:[]};
const flags={'intelligence.overview':true,'intelligence.usage_collection':true,'content.analytics_dashboard':true,'members.module_enabled':true,'cell_groups.module_enabled':true,'visitors.module_enabled':true,'ministries.module_enabled':true,'devotionals.module_enabled':true};
const request=(route,method='GET',body={})=>({path:'/intelligence/'+route,httpMethod:method,headers:{'x-organization-id':'org-a'},queryStringParameters:{organization_id:'org-a',campus_id:'campus-a'},body:JSON.stringify(body)});
const interaction=(overrides={})=>({id:'event-a',session_id:'session-a',name:'screen_view',module:'home',version:'v2',occurred_at:new Date().toISOString(),...overrides});
const message=(overrides={})=>({type:'PWA_USAGE_V1',organization_id:'org-a',campus_id:'campus-a',user_id:'user-a',consent_revision:1,received_at:new Date().toISOString(),events:[interaction()],...overrides});
beforeEach(()=>{process.env.INTELLIGENCE_QUEUE_URL='https://queue.example.test';state={calls:[],queued:[],user:{...user},birth:'1990-04-15',owned:true,contentCampus:'campus-a',memberExists:true,campusExists:true,rate:true,flags:{...flags},started:'2026-01-01T00:00:00Z',people:20,commits:0,rollbacks:0,auditFail:false,data:{consent:{allowed:1,revision:1,policy_version:model.INTELLIGENCE_VERSION,updated_at:'2020-01-01T00:00:00Z'},receipts:new Set(),interactions:0}};});

test('month comparisons use complete, equal local days including short months and year rollover',()=>{
  const p=model.intelligencePeriod('month',new Date('2026-11-06T14:00:00Z'));
  assert.deepEqual([p.start,p.end,p.previousStart,p.previousEnd],['2026-11-01','2026-11-06','2026-10-01','2026-10-06']);
  const short=model.intelligencePeriod('month',new Date('2026-03-31T14:00:00Z'));
  assert.equal(short.end,'2026-03-29');assert.equal(short.previousEnd,'2026-03-01');
  const first=model.intelligencePeriod('month',new Date('2027-01-01T14:00:00Z'));
  assert.equal(first.start,'2026-12-01');assert.equal(first.previousStart,'2026-11-01');
  assert.equal(model.dayInSaoPaulo(new Date('2026-11-06T02:00:00Z')),'2026-11-05');
});
test('zero, unknown and negative comparison bases never invent percentages',()=>{
  assert.equal(model.variation(250,200).percent,25);assert.equal(model.variation(10,0).percent,null);assert.equal(model.variation(0,0).reason,'zero_baseline');assert.equal(model.variation(null,10).delta,null);assert.equal(model.variation(20,-10).percent,null);
});
test('adult eligibility respects birthday and rejects missing or invalid dates',()=>{
  const now=new Date('2026-11-06T14:00:00Z');assert.equal(model.adultEligibility('2008-11-06',now),true);assert.equal(model.adultEligibility('2008-11-07',now),false);assert.equal(model.adultEligibility(null,now),false);assert.equal(model.adultEligibility('2000-02-31',now),false);
});
test('event normalization strips private text and rejects unknown modules, IDs, dates and unpaid capabilities',()=>{
  const clean=model.validateUsageBatch([interaction({email:'private@example.test',note:'private text',organization_id:'other'})],flags);
  assert.equal(clean[0].email,undefined);assert.equal(clean[0].note,undefined);assert.equal(clean[0].organization_id,undefined);
  for(const event of [interaction({id:undefined}),interaction({module:'unknown'}),interaction({session_id:123}),interaction({occurred_at:'2020-01-01'}),interaction({module:'store'})])assert.throws(()=>model.validateUsageBatch([event],flags));
  assert.notEqual(model.subjectKey('org-a','person'),model.subjectKey('org-b','person'));
});
test('private endpoints require authentication and role; public preflight does not',async()=>{
  state.user=null;assert.equal((await handler(request('overview'))).statusCode,401);assert.equal((await handler(request('events','OPTIONS'))).statusCode,204);
  state.user={...user,role:'MEMBER'};assert.equal((await handler(request('overview'))).statusCode,403);
  state.flags['intelligence.overview']=false;state.user={...user};assert.equal((await handler(request('overview'))).statusCode,403);
});
test('conflicting organizations and unauthorized campus cannot reach aggregation',async()=>{
  const req=request('overview');req.queryStringParameters.organization_id='org-b';assert.equal((await handler(req)).statusCode,403);
  const campus=request('overview');campus.queryStringParameters.campus_id='campus-b';assert.equal((await handler(campus)).statusCode,403);
  assert.equal(state.calls.some(call=>call.sql.includes('COUNT(')),false);
});
test('all-campus scope narrows to authorized units and leaders only receive their groups',async()=>{
  const req=request('overview');req.queryStringParameters.campus_id='all';state.user={...user,role:'LEADER'};
  const scope=await intelligenceScope(req,state.user);assert.deepEqual(scope.campusIds,['campus-a']);assert.deepEqual(scope.cellIds,['cell-owned']);
  const filter=scopedWhere(scope,'a','campus_id','cell_group_id');assert.deepEqual(filter.params,['campus-a','cell-owned']);assert.match(filter.sql,/IN \(\?\)/);
});
test('consent is off by default and cannot be granted for minors or an old policy',async()=>{
  state.data.consent=null;const p=await usage.usagePreference('org-a',user);assert.equal(p.allowed,false);
  state.birth='2020-01-01';const response=await handler(request('me/usage','POST',{allowed:true,expected_revision:0,policy_version:model.INTELLIGENCE_VERSION}));assert.equal(response.statusCode,403);
  state.birth='1990-01-01';const bad=await handler(request('me/usage','POST',{allowed:true,expected_revision:0,policy_version:'obsolete'}));assert.equal(bad.statusCode,400);
});
test('revocation invalidates in-flight messages and deletes only scoped behavioral records',async()=>{
  state.data.interactions=9;const queued=message();
  const result=await usage.setUsagePreference('org-a',user,{allowed:false,expected_revision:1,policy_version:model.INTELLIGENCE_VERSION},request('me/usage','POST'));
  assert.equal(result.allowed,false);assert.equal(state.data.interactions,0);assert.equal(state.data.consent.revision,2);
  await usage.processUsage(queued);assert.equal(state.data.interactions,0);
  for(const call of state.calls.filter(call=>call.sql.startsWith('DELETE')))assert.ok(call.params.includes('org-a'));
});
test('a member losing age eligibility can still withdraw authorization and remove their old usage',async()=>{
  state.birth=null;const preference=await usage.usagePreference('org-a',user);assert.equal(preference.eligible,false);assert.equal(preference.allowed,true);
  assert.equal((await handler(request('events','POST',{events:[interaction()]}))).statusCode,403);
  const result=await usage.setUsagePreference('org-a',user,{allowed:false,expected_revision:1,policy_version:model.INTELLIGENCE_VERSION},{});assert.equal(result.allowed,false);
});
test('grant based on stale revision cannot undo a withdrawal; audit failure rolls the preference back',async()=>{
  state.data.consent.revision=3;await assert.rejects(()=>usage.setUsagePreference('org-a',user,{allowed:true,expected_revision:1,policy_version:model.INTELLIGENCE_VERSION},{}),/outra sessão/);
  state.auditFail=true;await assert.rejects(()=>usage.setUsagePreference('org-a',user,{allowed:false,expected_revision:3,policy_version:model.INTELLIGENCE_VERSION},{}),/AUDIT_FAILURE/);
  assert.equal(state.data.consent.allowed,1);assert.equal(state.data.consent.revision,3);
});
test('collection resolves identity server-side and requires both consent and the operational flag',async()=>{
  const response=await handler(request('events','POST',{events:[interaction()],user_id:'victim',role:'SUPERADMIN'}));assert.equal(response.statusCode,202);assert.equal(state.queued[0].user_id,'user-a');
  state.data.consent.allowed=0;assert.equal((await handler(request('events','POST',{events:[interaction()]}))).statusCode,403);
  state.data.consent.allowed=1;state.flags['intelligence.usage_collection']=false;assert.equal((await handler(request('events','POST',{events:[interaction()]}))).statusCode,403);
});
test('worker deduplicates delivery and never records events preceding consent',async()=>{
  await usage.processUsage(message());await usage.processUsage(message());assert.equal(state.data.interactions,1);
  state.data.consent.updated_at=new Date(Date.now()+10000).toISOString();await usage.processUsage(message({events:[interaction({id:'event-b'})]}));assert.equal(state.data.interactions,1);
});
test('worker ignores expired messages, disabled collection and changed consent revision',async()=>{
  await usage.processUsage(message({received_at:'2020-01-01T00:00:00Z'}));assert.equal(state.data.interactions,0);
  await usage.processUsage(message({consent_revision:0}));assert.equal(state.data.interactions,0);
  state.flags['intelligence.usage_collection']=false;await usage.processUsage(message());assert.equal(state.data.interactions,0);
});
test('invalid queue items fail individually while valid messages commit',async()=>{
  const response=await intelligenceWorker({Records:[{messageId:'bad',body:'{}'},{messageId:'good',body:JSON.stringify(message())}]});assert.deepEqual(response.batchItemFailures,[{itemIdentifier:'bad'}]);assert.equal(state.data.interactions,1);
});
test('small behavioral samples hide counts and differences; data absence is not zero',async()=>{
  state.people=4;let response=await handler(request('overview'));assert.equal(response.statusCode,200);
  let metric=JSON.parse(response.body).metrics.find(m=>m.key==='digital_active');assert.equal(metric.value,null);assert.equal(metric.change.delta,null);assert.equal(metric.status,'insufficient_sample');
  state.started=null;response=await handler(request('overview'));metric=JSON.parse(response.body).metrics.find(m=>m.key==='digital_active');assert.equal(metric.status,'not_measured');assert.equal(metric.value,null);
  state.started=new Date().toISOString();response=await handler(request('overview'));metric=JSON.parse(response.body).metrics.find(m=>m.key==='digital_active');assert.equal(metric.status,'not_measured');assert.equal(metric.value,null,'A measurement starting today cannot turn the previous completed days into zero');
});
test('overview reads are tenant-scoped and a current stock is never labeled as historical growth',async()=>{
  const response=await handler(request('overview'));assert.equal(response.statusCode,200);const body=JSON.parse(response.body);
  const stock=body.metrics.find(m=>m.key==='registered_members');assert.equal(stock.reference,'current_state');assert.equal(stock.previous,null);
  for(const call of state.calls.filter(call=>call.sql.includes('SELECT')))assert.ok(call.params.includes('org-a'),call.sql);
});
test('360 timeline now resolves tenant, unit and leader scope before returning member data',async()=>{
  const req=request('overview');req.path='/pastoral/members/person/timeline';req.pathParameters={id:'person'};
  req.queryStringParameters.organization_id='org-b';assert.equal((await getMemberTimeline360(req)).statusCode,403);
  req.queryStringParameters.organization_id='org-a';state.memberExists=false;assert.equal((await getMemberTimeline360(req)).statusCode,404);
  const memberQuery=state.calls.find(call=>call.sql.includes('WHERE m.id'));assert.match(memberQuery.sql,/m.organization_id = \?/);assert.ok(memberQuery.params.includes('campus-a'));
});
test('new intelligence flags preserve old commercial snapshots and explicit denials',()=>{
  const {normalizeEntitlements,COMMERCIAL_CATALOG}=require('../src/services/planCatalog.ts');const old={...COMMERCIAL_CATALOG.plans[0].entitlements};delete old['intelligence.overview'];delete old['intelligence.usage_collection'];
  assert.equal(normalizeEntitlements(old)['intelligence.overview'],true);old['intelligence.overview']=false;assert.equal(normalizeEntitlements(old)['intelligence.overview'],false);
});
