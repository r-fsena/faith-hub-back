process.env.AWS_EC2_METADATA_DISABLED='true';
const {test,beforeEach}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
let state,snapshot;
function mock(file,exports){const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports};}
async function execute(sql,params=[]){
 assert.equal((sql.match(/\?/g)||[]).length,params.length,sql);state.calls.push({sql,params});
 if(sql.includes('security_audit_logs')&&state.auditFail)throw Error('AUDIT_UNAVAILABLE');
 if(sql.includes('INSERT IGNORE INTO intelligence_invitation_events')){state.writes.push({sql,params});return{affectedRows:1};}
 if(sql.includes('WITH invited'))return state.cohorts;
 if(sql.includes('WITH population'))return [];
 if(sql.includes('FROM tenant_feature_flags'))return [{last_changed:state.lastPolicyChange||null}];
 if(sql.includes('FROM campuses'))return state.campusExists?[{id:'campus-a',name:'Unidade sintética'}]:[];
 if(sql.includes('FROM church_visitors v'))return state.visitorExists?[{...state.visitor}]:[];
 if(sql.includes('FROM cell_groups'))return state.cellExists?[{id:'cell-a',name:'Grupo sintético',leader_id:'leader-a',campus_id:'campus-a'}]:[];
 if(sql.includes('FROM intelligence_welcome_state')&&sql.includes('visitor_id <>'))return state.duplicateVisitor?[{visitor_id:'other'}]:[];
 if(sql.includes('FROM intelligence_welcome_state'))return [{version:3,linked_member_id:state.linkedMember}];
 if(sql.includes('FROM members')&&sql.includes('SELECT id FROM'))return state.linkValid?[{id:'member-a'}]:[];
 if(sql.includes('FROM members'))return state.ownerExists?[{id:'admin-a',role:state.ownerRole,campus_id:'campus-a',campus_ids:state.ownerCampuses}]:[];
 if(sql.includes('first_present'))return [{first_present:state.present?'2026-11-01T12:00:00.000Z':null}];
 if(sql.includes('SELECT a.* FROM intelligence_actions'))return state.actionExists?[{id:'action-a',campus_id:'campus-a',cell_group_id:'cell-a',owner_id:'admin-a',status:state.actionStatus||'NEW',version:2,due_date:'2026-12-01'}]:[];
 if(sql.includes('SELECT g.* FROM intelligence_goals'))return [{id:'goal-a',campus_id:'campus-a',cell_group_id:'cell-a',version:2,status:'ACTIVE'}];
 if(sql.includes('SELECT id,request_hash FROM intelligence_actions'))return [{id:'existing-action',request_hash:state.requestHash}];
 if(sql.includes('SELECT request_hash FROM intelligence_goals'))return [{request_hash:state.requestHash}];
 if(sql.includes('INSERT IGNORE INTO intelligence_actions')||sql.includes('INSERT IGNORE INTO intelligence_goals')){if(state.duplicate)return{affectedRows:0};state.writes.push({sql,params});return{affectedRows:1};}
 if(/^\s*(INSERT|UPDATE|DELETE)/.test(sql)){state.writes.push({sql,params});return{affectedRows:1};}
 if(sql.includes('WITH invited'))return state.cohorts;
 if(sql.includes('WITH population'))return [];
 if(sql.includes('intelligence_invitation_events'))return [{registered:1,invitation_requested:1,requests:2,failed_requests:1,started_at:null}];
 if(sql.includes('cell_meetings'))return [];
 if(sql.includes('FROM pastoral_care_logs'))return [];
 if(sql.includes('intelligence_actions')||sql.includes('intelligence_goals')||sql.includes('intelligence_welcome_events'))return [];
 throw Error('UNEXPECTED_SQL: '+sql);
}
mock('../src/db/index.ts',{apiResponse:(statusCode,body,headers)=>({statusCode,body:JSON.stringify(body),headers}),query:async(s,p)=>({rows:await execute(s,p)}),getConnection:async()=>({
 query:async(s,p)=>[await execute(s,p)],beginTransaction:async()=>{snapshot=structuredClone(state.writes);},commit:async()=>{state.commits++;},rollback:async()=>{state.writes=snapshot;state.rollbacks++;},release:()=>{}
})});
mock('../src/services/featureFlagService.ts',{evaluateTenantFlags:async()=>({flags:state.flags})});
mock('../src/services/rateLimiter.ts',{checkRateLimit:async()=>({allowed:true})});
const auth=require('../src/services/authMiddleware.ts');auth.requireAuth=async()=>state.user?{user:state.user}:{errorResponse:{statusCode:401,body:'{}'}};
mock('../src/services/planAccess.ts',{enforcePlanAccess:async()=>null});
const {intelligenceHandler:handler}=require('../src/functions/intelligence.ts');
const {createWelcomeVisitor}=require('../src/services/intelligenceWelcomeLegacy.ts');
const {recordInvitationMilestone}=require('../src/services/intelligenceInvitation.ts');
const {assertActionTransition,validDay}=require('../src/services/intelligenceJourneyModel.ts');
const user={userId:'admin-a',email:'synthetic@example.test',role:'ADMIN',organizationId:'org-a',campusIds:['campus-a'],isSuperAdmin:false,operationalPermissions:[]};
const flags={'intelligence.overview':true,'intelligence.activation':true,'intelligence.member_journey':true,'intelligence.actions':true,'intelligence.goals':true,'intelligence.usage_collection':true,'members.module_enabled':true,'visitors.module_enabled':true,'cell_groups.module_enabled':true,'devotionals.module_enabled':true};
function request(path,method='GET',body={}){return{path:'/intelligence/'+path,httpMethod:method,headers:{'x-organization-id':'org-a'},queryStringParameters:{organization_id:'org-a',campus_id:'campus-a'},body:JSON.stringify(body)};}
const action=()=>({request_id:'request-a',title:'Revisar implantação da unidade',campus_id:'campus-a',owner_id:'admin-a',due_date:'2026-12-01',subject_type:'metric',subject_id:'data_quality'});
const goal=()=>({request_id:'ef117540-f646-49b9-bd59-ed881c87c310',title:'Acompanhar contatos registrados',campus_id:'campus-a',owner_id:'admin-a',metric:'visitors_contacted',target_count:10,start_date:'2026-11-01',end_date:'2026-11-30'});
beforeEach(()=>{state={user:{...user},flags:{...flags},calls:[],writes:[],commits:0,rollbacks:0,auditFail:false,campusExists:true,visitorExists:true,cellExists:true,ownerExists:true,ownerRole:'ADMIN',ownerCampuses:['campus-a'],linkValid:true,linkedMember:null,present:false,duplicateVisitor:false,actionExists:true,duplicate:false,cohorts:[],visitor:{id:'visitor-a',name:'Visitante sintético',campus_id:'campus-a',stage:'NEW',assigned_cell_id:'cell-a',assigned_leader_id:'leader-a',first_visit_date:'2026-11-01'}};});

test('journey, action and goal routes require authentication, canonical role and their own feature',async()=>{
 state.user=null;assert.equal((await handler(request('actions'))).statusCode,401);
 state.user={...user,role:'MEMBER'};assert.equal((await handler(request('goals'))).statusCode,403);
 state.user={...user};for(const [path,flag]of [['activation','intelligence.activation'],['community','intelligence.member_journey'],['actions','intelligence.actions'],['goals','intelligence.goals']]){
 state.flags[flag]=false;assert.equal((await handler(request(path))).statusCode,403);state.flags[flag]=true;}
 assert.equal(state.writes.length,0);
});
test('conflicting tenant, unauthorized campus and missing leader group cannot create records',async()=>{
 const req=request('actions','POST',action());req.queryStringParameters.organization_id='org-b';assert.equal((await handler(req)).statusCode,403);
 const other=request('actions','POST',{...action(),campus_id:'campus-b'});assert.equal((await handler(other)).statusCode,403);
 state.user={...user,role:'LEADER'};assert.equal((await handler(request('actions','POST',action()))).statusCode,403);
 assert.equal(state.writes.length,0);
});
test('owners outside the unit or without the required group cannot be assigned',async()=>{
 state.ownerCampuses=['campus-b'];assert.equal((await handler(request('actions','POST',action()))).statusCode,400);
 state.ownerCampuses=['campus-a'];state.ownerRole='LEADER';assert.equal((await handler(request('actions','POST',action()))).statusCode,400);
 assert.equal(state.writes.length,0);
});
test('action creation is audited atomically and audit failures roll back the new record',async()=>{
 let result=await handler(request('actions','POST',action()));assert.equal(result.statusCode,200);assert.equal(state.commits,1);assert.ok(state.writes.some(c=>c.sql.includes('security_audit_logs')));
 state.auditFail=true;state.writes=[];result=await handler(request('actions','POST',action()));assert.equal(result.statusCode,503);assert.equal(state.writes.length,0);assert.equal(state.rollbacks,1);
});
test('stale action versions, invalid transitions and conflicting request reuse are rejected',async()=>{
 assert.equal((await handler(request('actions/action-a','PATCH',{expected_version:1,status:'IN_REVIEW'}))).statusCode,409);
 assert.equal((await handler(request('actions/action-a','PATCH',{expected_version:2,status:'COMPLETED',resolution:'RESOLVED'}))).statusCode,400);
 state.duplicate=true;state.requestHash='different';assert.equal((await handler(request('actions','POST',action()))).statusCode,409);
 assert.equal(state.writes.length,0);
});
test('completed/discarded actions require a reason and can be reopened only into review',()=>{
 assert.throws(()=>assertActionTransition('IN_REVIEW','COMPLETED'),/motivo/);
 assert.doesNotThrow(()=>assertActionTransition('IN_REVIEW','COMPLETED','RESOLVED'));
 assert.throws(()=>assertActionTransition('COMPLETED','NEW'),/inválida/);
 assert.doesNotThrow(()=>assertActionTransition('DISMISSED','IN_REVIEW'));
});
test('goals reject fabricated metrics, invalid dates, negative quantities and stale versions',async()=>{
 for(const body of [{...goal(),metric:'donation_propensity'},{...goal(),target_count:-1},{...goal(),start_date:'2026-02-31'},{...goal(),end_date:'2028-01-01'}])assert.notEqual((await handler(request('goals','POST',body))).statusCode,200);
 assert.equal((await handler(request('goals/goal-a','PATCH',{expected_version:1,status:'COMPLETED'}))).statusCode,409);
 assert.equal(state.writes.length,0);assert.equal(validDay('2026-02-31'),false);
});
test('goal creation uses a source-backed metric and writes strict audit in the same transaction',async()=>{
 const result=await handler(request('goals','POST',goal()));assert.equal(result.statusCode,200);assert.equal(state.commits,1);
 assert.ok(state.writes.some(c=>c.sql.includes('INSERT IGNORE INTO intelligence_goals')));assert.ok(state.writes.some(c=>c.sql.includes('security_audit_logs')));
});
test('welcome cannot infer attendance or integration from stage selection without a matching presence',async()=>{
 const result=await handler(request('welcome/visitors/visitor-a','POST',{operation:'stage',stage:'INTEGRATED_MEMBER',member_id:'member-a',expected_version:3}));
 assert.equal(result.statusCode,400);assert.equal(state.writes.length,0);
 state.present=true;state.linkValid=false;assert.equal((await handler(request('welcome/visitors/visitor-a','POST',{operation:'link',member_id:'member-a',expected_version:3}))).statusCode,400);
});
test('welcome versions, duplicate member links and tenant-scoped lookups protect independent journeys',async()=>{
 assert.equal((await handler(request('welcome/visitors/visitor-a','POST',{stage:'CONTACTED_24H',expected_version:2}))).statusCode,409);
 state.duplicateVisitor=true;assert.equal((await handler(request('welcome/visitors/visitor-a','POST',{operation:'link',member_id:'member-a',expected_version:3}))).statusCode,409);
 state.visitorExists=false;assert.equal((await handler(request('welcome/visitors/visitor-a','POST',{stage:'CONTACTED_24H',expected_version:3}))).statusCode,404);
 assert.ok(state.calls.filter(c=>c.sql.includes('SELECT v.*')).every(c=>c.sql.includes('v.organization_id = ?')&&c.params.includes('campus-a')));
});
test('contact and archive retain an audited history instead of deleting visitor data',async()=>{
 const result=await handler(request('welcome/visitors/visitor-a','POST',{stage:'ARCHIVED',expected_version:3}));assert.equal(result.statusCode,200);
 assert.equal(JSON.parse(result.body).journey_version,4);assert.ok(state.writes.some(c=>c.sql.includes('intelligence_welcome_events')));assert.ok(state.writes.every(c=>!/^DELETE/.test(c.sql)));
});
test('public visitor registration never downgrades an invalid bearer token to anonymous',async()=>{
 state.user=null;const req=request('welcome','POST',{name:'Visitante sintético',phone:'11999999999',organization_id:'org-a',campus_id:'campus-a'});req.headers.Authorization='Bearer invalid';
 assert.equal((await createWelcomeVisitor(req)).statusCode,401);assert.equal(state.writes.length,0);
});
test('invitation metrics store only provider outcomes and scope insertion through the member tenant',async()=>{
 await recordInvitationMilestone('org-a','member-a','CSV','REQUESTED',{requestContext:{requestId:'request-a'}},true);
 const insert=state.writes[0];assert.match(insert.sql,/FROM members WHERE organization_id = \? AND id = \?/);assert.equal(insert.params.includes(user.email),false);
 assert.ok(!insert.sql.includes('password'));state.writes=[];await recordInvitationMilestone('org-a','member-a','CSV','REQUESTED',{},false);assert.equal(state.writes.length,0);
});
test('digital activation hides a small authorized sample and never turns unmeasured use into zero',async()=>{
 state.cohorts=[{cohort:'2026-11',invited:20,authorized:1,measured_access:1,qualified_use:0,mature_return:0,returned:0}];
 const result=await handler(request('activation'));assert.equal(result.statusCode,200);const cohort=JSON.parse(result.body).cohorts[0];
 assert.equal(cohort.authorized,null);assert.equal(cohort.qualified_use,null);assert.equal(cohort.return_percent,null);
});
test('new contract keys extend old snapshots without granting visitor analytics to a plan without visitors',()=>{
 const {extend}=require('../migrate_intelligence_journeys.js');
 const connecting=extend({'content.analytics_dashboard':true,'visitors.module_enabled':false});assert.equal(connecting['intelligence.activation'],true);assert.equal(connecting['intelligence.member_journey'],false);
 assert.equal(extend({'intelligence.overview':true,'intelligence.actions':false})['intelligence.actions'],false);
 const {normalizeEntitlements,COMMERCIAL_CATALOG}=require('../src/services/planCatalog.ts');const old={...COMMERCIAL_CATALOG.plans[0].entitlements};for(const key of Object.keys(require('../migrate_intelligence_journeys.js').additions))delete old[key];
 assert.equal(normalizeEntitlements(old)['intelligence.member_journey'],false);old['intelligence.actions']=false;assert.equal(normalizeEntitlements(old)['intelligence.actions'],false);
});
test('provisioning preserves contractual rights while keeping the next delivery in a tenant pilot',async()=>{
 const {initializePlanEntitlements}=require('../src/services/planProvisioning.ts');const {COMMERCIAL_CATALOG}=require('../src/services/planCatalog.ts');const writes=[];
 const contract={name:'Plano de teste',entitlements:COMMERCIAL_CATALOG.plans[1].entitlements};
 await initializePlanEntitlements('org-new',contract,async(sql,params)=>writes.push({sql,params}));
 for(const key of Object.keys(require('../migrate_intelligence_journeys.js').additions)){
  assert.equal(contract.entitlements[key],true);assert.equal(writes.find(c=>c.params[2]===key).params[3],0);
 }
});
test('activation protects small complements and differences between otherwise large stages',async()=>{
 state.cohorts=[{cohort:'2026-11',invited:100,authorized:95,measured_access:80,qualified_use:60,mature_return:50,returned:20}];
 const response=await handler(request('activation'));assert.equal(response.statusCode,200);const cohort=JSON.parse(response.body).cohorts[0];
 assert.equal(cohort.authorized,null);assert.equal(cohort.measured_access,null);assert.equal(cohort.return_percent,null);
});
test('visitor and cell origins do not bypass the contracted source module',async()=>{
 state.flags['cell_groups.module_enabled']=false;
 assert.equal((await handler(request('welcome/visitors/visitor-a','POST',{operation:'link',member_id:'member-a',expected_version:3}))).statusCode,403);
 state.flags['visitors.module_enabled']=false;
 assert.equal((await handler(request('actions','POST',{...action(),subject_type:'visitor',subject_id:'visitor-a'}))).statusCode,403);
 assert.equal(state.writes.length,0);
});
test('closing a snoozed action clears the delay without requiring a separate manual edit',async()=>{
 state.actionStatus='IN_REVIEW';
 const response=await handler(request('actions/action-a','PATCH',{expected_version:2,status:'COMPLETED',resolution:'RESOLVED',snoozed_until:'2026-12-01'}));
 assert.equal(response.statusCode,200);const write=state.writes.find(c=>c.sql.includes('UPDATE intelligence_actions'));
 assert.equal(write.params[3],null);assert.equal(write.params[4],'RESOLVED');
});
test('legacy executive report is scoped to the current leader groups, units and own care records',async()=>{
 state.user={...user,role:'LEADER'};
 const {getExecutiveReport}=require('../src/functions/pastoralCare.ts');const req=request('overview');req.path='/pastoral/executive-report';
 const response=await getExecutiveReport(req);assert.equal(response.statusCode,200);
 const visitors=state.calls.find(c=>c.sql.includes('AS total_visitors'));assert.match(visitors.sql,/v.assigned_cell_id IN/);assert.ok(visitors.params.includes('cell-a'));assert.ok(visitors.params.includes('campus-a'));
 const care=state.calls.find(c=>c.sql.includes('FROM pastoral_care_logs'));assert.match(care.sql,/pcl.caregiver_id = \?/);assert.ok(care.params.includes(user.userId));
});
