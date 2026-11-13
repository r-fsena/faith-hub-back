// Disposable, explicitly named QA schema. Copies structure only; never customer records.
require('dotenv').config({quiet:true});process.env.AWS_EC2_METADATA_DISABLED='true';
const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),{randomUUID,randomBytes}=require('node:crypto');
const {createAdminConnection}=require('./db-admin.cjs'),schema=require('./foundation-schema.cjs');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
function mock(file,exports){const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports};}
const financialOnly=process.argv.includes('--financial-only');
const localPort=process.env.FAITH_FOUNDATION_QA_PORT;if(localPort&&localPort!=='33307')throw Error('QA_LOCAL_PORT_MUST_BE_33307');
const connectTarget=()=>localPort?require('mysql2/promise').createConnection({host:'127.0.0.1',port:33307,user:'root',password:''}):createAdminConnection();
let db,qa,created=false,stage='connect',failAudit=false,count=0;
const check=()=>count++;
(async()=>{if(!process.argv.includes('--isolated-schema'))throw Error('ISOLATED_SCHEMA_REQUIRED');db=await createAdminConnection();
 const originals=['members','tenant_feature_flags','church_financial_transactions','church_special_projects','campuses','security_audit_logs'];const ddls=[];
 for(const table of originals){const [rows]=await db.query('SHOW CREATE TABLE '+table);ddls.push(rows[0]['Create Table'].split('\n').filter(line=>!/^\s*CONSTRAINT\s/.test(line)).join('\n').replace(/,\n\)/g,'\n)'));}
 if(localPort){await db.end();db=await connectTarget();}
 qa='faith_foundation_qa_'+randomBytes(6).toString('hex');assert.match(qa,/^faith_foundation_qa_[0-9a-f]{12}$/);
 stage='isolated schema';await db.query(`CREATE DATABASE \`${qa}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);created=true;await db.query(`USE \`${qa}\``);
 for(const sql of ddls)await db.query(sql);for(const sql of schema.tables)await db.query(sql);
 for(const [key,value]of Object.entries(schema.columns))await db.query(`ALTER TABLE church_financial_transactions ADD COLUMN ${key} ${value}`);
 await db.query(schema.reportingView);if(!financialOnly)for(const sql of schema.triggers)await db.query(sql);
 const org='foundation-org-a',other='foundation-org-b',ca='foundation-ca',cb='foundation-cb';
 const flags={'intelligence.overview':true,'intelligence.finance':true,'intelligence.history':true,'members.module_enabled':true,'financial.accounts_ledger':true,'financial.module_enabled':true,'financial.cashflow_ledger':true};
 mock('../src/services/featureFlagService.ts',{evaluateTenantFlags:async(o,c)=>({flags:o===org?{...flags}:Object.fromEntries(Object.keys(flags).map(k=>[k,false]))})});
 const connections=new Set();
 async function connect(){const c=await connectTarget();await c.query(`USE \`${qa}\``);connections.add(c);return {query:async(sql,params=[])=>{assert.equal((sql.match(/\?/g)||[]).length,params.length,sql);if(failAudit&&sql.includes('INSERT INTO security_audit_logs'))throw Error('QA_AUDIT_FAILURE');return c.query(sql,params);},beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),destroy:()=>{connections.delete(c);c.destroy();},release:()=>{connections.delete(c);void c.end();}};}
 mock('../src/db/index.ts',{getConnection:connect,query:async(sql,params=[])=>{assert.equal((sql.match(/\?/g)||[]).length,params.length,sql);const [rows]=await db.query(sql,params);return{rows};},apiResponse:(statusCode,body)=>({statusCode,body:JSON.stringify(body)})});
 const ledger=require('../src/services/financialLedger.ts'),history=require('../src/services/memberHistory.ts'),writer=require('../src/services/memberHistoryWrite.ts'),model=require('../src/services/intelligenceModel.ts');
 const user={userId:'foundation-admin',email:'qa@example.test',organizationId:org,role:'ADMIN',campusIds:['all'],isSuperAdmin:false,operationalPermissions:[]};
 const scope={user,organizationId:org,campusId:ca,campusIds:[ca],cellIds:null},all={...scope,campusId:null,campusIds:null},foreign={...scope,organizationId:other},event={requestContext:{requestId:'qa-foundation'}};
 const today=model.dayInSaoPaulo(),shift=n=>new Date(Date.parse(today+'T12:00:00Z')+n*86400000).toISOString().slice(0,10),yesterday=shift(-1);
 await db.query("INSERT INTO campuses(id,organization_id,name,slug,status) VALUES(?,?,?,'qa-ca','ACTIVE'),(?,?,?,'qa-cb','ACTIVE')",[ca,org,'Synthetic A',cb,org,'Synthetic B']);
 await db.query("INSERT INTO tenant_feature_flags(id,organization_id,feature_key,is_enabled,environment,category,description) VALUES('qa-history',?,'intelligence.history',1,'production','QA','QA')",[org]);
 await db.query("INSERT INTO members(id,organization_id,name,email,role,status,campus_id) VALUES('qa-member',?,'Synthetic','synthetic@example.test','MEMBER','ACTIVE',?),('qa-other',?,'Synthetic other','other@example.test','MEMBER','ACTIVE',?)",[org,ca,other,ca]);
 let rows,n;
 if(!financialOnly){
 stage='baseline and transactional history';await db.beginTransaction();await schema.initializeHistoryBaseline(db,org,user.userId);await db.commit();
 [rows]=await db.query('SELECT * FROM member_state_history');assert.equal(rows.length,1);assert.equal(rows[0].kind,'BASELINE');assert.equal(rows[0].before_status,null);check();
 await writer.memberStateWrite('UPDATE members SET status=? WHERE organization_id = ? AND id = ?',['INACTIVE',org,'qa-member'],{organizationId:org,user,source:'STATUS',event,memberId:'qa-member'});
 [rows]=await db.query('SELECT * FROM member_state_history ORDER BY sequence_id DESC');assert.equal(rows[0].source,'STATUS');assert.equal(rows[0].actor_id,user.userId);assert.equal(rows[0].before_status,'ACTIVE');assert.equal(rows[0].after_status,'INACTIVE');check();
 await db.query("UPDATE members SET phone='000' WHERE organization_id = ? AND id='qa-member'",[org]);[n]=await db.query('SELECT COUNT(*) AS n FROM member_state_history');assert.equal(n[0].n,2);check();
 await db.query("UPDATE members SET campus_id=? WHERE organization_id = ? AND id='qa-member'",[cb,org]);[rows]=await db.query('SELECT * FROM member_state_history ORDER BY sequence_id DESC');assert.equal(rows[0].source,'DATABASE');assert.equal(rows[0].actor_id,null);check();
 const limited=await history.memberHistory(scope,'month');const move=limited.events.find(e=>e.kind==='CHANGED'&&e.after.restricted);assert.ok(move);assert.equal(move.member_id,null);assert.equal(move.before.campus_id,ca);assert.equal(limited.snapshots.current,null);check();
 await assert.rejects(db.query("UPDATE members SET organization_id=? WHERE organization_id = ? AND id='qa-member'",[other,org]),/TRACKED_MEMBER_TENANT_CHANGE/);check();
 failAudit=true;await assert.rejects(writer.memberStateWrite('UPDATE members SET role=? WHERE organization_id = ? AND id = ?',['LEADER',org,'qa-member'],{organizationId:org,user,source:'PROFILE'}),/QA_AUDIT_FAILURE/);failAudit=false;
 [rows]=await db.query("SELECT role FROM members WHERE organization_id = ? AND id='qa-member'",[org]);assert.equal(rows[0].role,'MEMBER');[n]=await db.query('SELECT COUNT(*) AS n FROM member_state_history');assert.equal(n[0].n,3);check();
 await db.query("UPDATE tenant_feature_flags SET is_enabled=0 WHERE organization_id = ? AND id='qa-history'",[org]);await db.query("UPDATE tenant_feature_flags SET is_enabled=1 WHERE organization_id = ? AND id='qa-history'",[org]);assert.equal((await history.historyCoverage(org)).ready,false);check();
 await db.query("UPDATE members SET status='ACTIVE' WHERE organization_id = ? AND id='qa-member'",[org]);[n]=await db.query('SELECT COUNT(*) AS n FROM member_state_history');assert.equal(n[0].n,3);check();
 await history.initializeMemberHistory(all,event);assert.equal((await history.historyCoverage(org)).ready,true);[n]=await db.query('SELECT COUNT(*) AS n FROM member_state_history');assert.equal(n[0].n,4);check();
 }
 stage='account idempotence and scope';const aid=randomUUID(),accountBody={request_id:aid,name:'Synthetic account',opening_on:shift(-15),opening_balance_cents:100000};
 assert.equal((await ledger.createLedgerAccount(scope,accountBody,event)).created,true);assert.equal((await ledger.createLedgerAccount(scope,accountBody,event)).created,false);await assert.rejects(ledger.createLedgerAccount(scope,{...accountBody,name:'Changed'},event),e=>e.status===409);check();
 await assert.rejects(ledger.createLedgerPosting(foreign,{request_id:randomUUID(),account_id:aid,type:'INCOME'},event),e=>e.status===404);await assert.rejects(ledger.createLedgerPosting({...scope,campusId:cb,campusIds:[cb]},{request_id:randomUUID(),account_id:aid,type:'INCOME'},event),e=>e.status===404);check();
 stage='partial settlements, retries and concurrency';const pid=randomUUID(),post={request_id:pid,account_id:aid,type:'INCOME',category:'Synthetic',description:'Synthetic partial',amount_cents:10000,payment_date:yesterday,payment_method:'PIX'};
 await ledger.createLedgerPosting(scope,post,event);assert.equal((await ledger.createLedgerPosting(scope,post,event)).created,false);check();
 const first={request_id:randomUUID(),amount_cents:4000,settled_on:shift(-2),expected_version:0};assert.equal((await ledger.settleLedgerPosting(scope,pid,first,event)).remaining_cents,6000);assert.equal((await ledger.settleLedgerPosting(scope,pid,first,event)).recorded,false);await assert.rejects(ledger.settleLedgerPosting(scope,pid,{...first,amount_cents:4100},event),e=>e.status===409);check();
 let [report]=await db.query("SELECT status,SUM(ROUND(amount*100)) AS cents FROM church_financial_reporting_transactions WHERE organization_id = ? AND original_transaction_id = ? GROUP BY status",[org,pid]);assert.deepEqual(Object.fromEntries(report.map(r=>[r.status,Number(r.cents)])),{PAID:4000,PENDING:6000});check();
 const concurrent=await Promise.allSettled([1,2].map(()=>ledger.settleLedgerPosting(scope,pid,{request_id:randomUUID(),amount_cents:4000,settled_on:yesterday,expected_version:1},event)));assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);assert.equal(concurrent.filter(r=>r.status==='rejected').length,1);check();
 await assert.rejects(ledger.settleLedgerPosting(scope,pid,{request_id:randomUUID(),amount_cents:2001,settled_on:yesterday,expected_version:2},event),e=>e.status===409);await ledger.settleLedgerPosting(scope,pid,{request_id:randomUUID(),amount_cents:2000,settled_on:yesterday,expected_version:2},event);check();
 const overview=await ledger.ledgerOverview(all);assert.equal(overview.accounts[0].balance_cents,110000);assert.equal(overview.postings[0].paid_cents,10000);assert.equal(overview.postings[0].remaining_cents,0);assert.equal(overview.postings[0].status,'PAID');check();
 [report]=await db.query("SELECT SUM(ROUND(amount*100)) AS cents,COUNT(*) AS fragments,COUNT(DISTINCT original_transaction_id) AS originals FROM church_financial_reporting_transactions WHERE organization_id = ? AND status='PAID'",[org]);assert.equal(Number(report[0].cents),10000);assert.equal(report[0].fragments,3);assert.equal(report[0].originals,1);check();
 assert.equal((await ledger.ledgerSettlements(scope,pid)).settlements.length,3);await assert.rejects(ledger.cancelLedgerPosting(scope,pid,{expected_version:3,reason:'QA cancel'},event),e=>e.status===409);check();
 stage='legacy compatibility and immutable writes';await db.query("INSERT INTO church_financial_transactions(id,organization_id,campus_id,type,category,description,amount,status,payment_date) VALUES('qa-pending',?,?,'EXPENSE','Synthetic','Synthetic legacy pending',20,'PENDING',?),('qa-paid',?,?,'INCOME','Synthetic','Synthetic legacy paid',50,'PAID',?)",[org,ca,yesterday,org,ca,yesterday]);
 await ledger.createLedgerPosting(scope,{request_id:randomUUID(),account_id:aid},event,'qa-pending');await assert.rejects(ledger.createLedgerPosting(scope,{request_id:randomUUID(),account_id:aid},event,'qa-paid'),e=>e.status===409);check();
 await ledger.cancelLedgerPosting(scope,'qa-pending',{expected_version:1,reason:'QA no longer needed'},event);await ledger.updateLedgerAccount(scope,aid,{expected_version:0,status:'INACTIVE'},event);check();
 await assert.rejects(ledger.updateLedgerAccount(scope,aid,{expected_version:1,status:'ACTIVE',opening_balance_cents:0},event),e=>e.status===400);check();
 const auth=require('../src/services/authMiddleware.ts');auth.requireAuth=async()=>({user});const req={httpMethod:'DELETE',path:'/financial/transactions/'+pid,pathParameters:{id:pid},headers:{'x-organization-id':org},queryStringParameters:{campus_id:ca},requestContext:{http:{sourceIp:'127.0.0.1'}}};
 flags['financial.accounts_ledger']=false;assert.equal((await ledger.legacyFinancialMutation(req,'delete')).statusCode,409);assert.equal((await ledger.legacyFinancialMutation({...req,pathParameters:{id:'qa-paid'}},'delete')).statusCode,409);check();
 stage='financial summary and intelligence consumers';
 mock('../src/services/planAccess.ts',{enforcePlanAccess:async()=>null});
 const {getFinancialSummary}=require('../src/functions/financial.ts'),{intelligenceOperations}=require('../src/services/intelligenceOperations.ts');
 const summaryResult=await getFinancialSummary({...req,httpMethod:'GET',queryStringParameters:{campus_id:ca}});assert.equal(summaryResult.statusCode,200,summaryResult.body);const summary=JSON.parse(summaryResult.body);assert.equal(Number(summary.summary.total_income),150);assert.equal(Number(summary.summary.total_expense),0);check();
 const intel=await intelligenceOperations(scope,'7d','finance');assert.deepEqual(intel.errors,[]);assert.equal(intel.sources.finance.metrics.find(m=>m.key==='income').value,15000);check();
 stage='strict financial audit rollback';flags['financial.accounts_ledger']=true;failAudit=true;await assert.rejects(ledger.createLedgerAccount(scope,{...accountBody,request_id:randomUUID(),name:'Must roll back'},event),/QA_AUDIT_FAILURE/);failAudit=false;[n]=await db.query('SELECT COUNT(*) AS n FROM church_financial_accounts WHERE organization_id = ?',[org]);assert.equal(n[0].n,1);check();
 [n]=await db.query('SELECT COUNT(*) AS n FROM security_audit_logs WHERE organization_id = ?',[org]);assert.ok(n[0].n>=(financialOnly?8:10));check();
 assert.equal(connections.size,0);console.log(JSON.stringify({result:'PASS',checks:count,disposableSchema:true,customerRecordsRead:0,customerRecordsChanged:0,historyTriggersValidated:!financialOnly,engineTarget:localPort?'localhost MySQL':'RDS disposable schema'}));
})().catch(e=>{console.error(JSON.stringify({result:'FAIL',stage,code:e.code||e.name,message:String(e.message).slice(0,1500)}));process.exitCode=1;}).finally(async()=>{if(db){try{if(created&&/^faith_foundation_qa_[0-9a-f]{12}$/.test(qa)){await db.query(`DROP DATABASE \`${qa}\``);console.log('QA_SCHEMA_REMOVED');}}finally{await db.end();}}});
