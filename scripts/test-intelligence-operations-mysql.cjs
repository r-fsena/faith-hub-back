// Connection-local TEMPORARY fixtures only. No customer records are selected or mutated.
require('dotenv').config({quiet:true});process.env.AWS_EC2_METADATA_DISABLED='true';
const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
const {createAdminConnection}=require('./db-admin.cjs');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
function mock(file,exports){const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports};}
let db,stage='connect';
(async()=>{if(!process.argv.includes('--temporary-only'))throw Error('TEMPORARY_ONLY_REQUIRED');db=await createAdminConnection();
 const tables=['campuses','church_financial_transactions','events','event_tickets','event_lots','pdv_orders','pdv_order_items','pdv_products','pdv_inventory_balances','kids_rooms','kids_checkins','service_schedules','service_roster_items','ministry_roles','ministries'];
 for(const table of tables){stage='temporary schema '+table;const [rows]=await db.query('SHOW CREATE TABLE '+table);const ddl=rows[0]['Create Table'].split('\n').filter(line=>!/^\s*CONSTRAINT\s/.test(line)).join('\n').replace(/^CREATE TABLE `[^`]+`/,`CREATE TEMPORARY TABLE \`${table}\``).replace(/,\n\)/g,'\n)');await db.query(ddl);}
 const org='ops_fixture_org',other='ops_fixture_other',a='ops_fixture_a',b='ops_fixture_b';
 const flags=Object.fromEntries(['intelligence.overview','intelligence.finance','intelligence.operations','intelligence.multicampus','system.multicampus_enabled','financial.module_enabled','financial.cashflow_ledger','events.module_enabled','pdv.module_enabled','pdv.stock_inventory','ministries.module_enabled','volunteers.module_enabled','kids.module_enabled','kids.reports_export'].map(k=>[k,true]));
 mock('../src/services/featureFlagService.ts',{evaluateTenantFlags:async(o,c)=>({flags:c===b?{...flags,'financial.cashflow_ledger':false,'intelligence.operations':false}:flags})});
 mock('../src/db/index.ts',{query:async(sql,params=[])=>{assert.equal((sql.match(/\?/g)||[]).length,params.length,sql);try{// These fixtures cover legacy version 0 only; the foundation test exercises the real view.
 const legacySql=sql.replaceAll('church_financial_reporting_transactions','church_financial_transactions').replaceAll('t.original_transaction_id','t.id');const [rows]=await db.query(legacySql,params);return{rows};}catch(e){console.error('fixture SQL error: '+e.code+' '+sql);throw e;}}});
 const model=require('../src/services/intelligenceModel.ts'),{intelligenceOperations}=require('../src/services/intelligenceOperations.ts');
 const today=model.dayInSaoPaulo(),shift=n=>new Date(Date.parse(today+'T12:00:00Z')+n*86400000).toISOString().slice(0,10),date=shift(-2),past=shift(-9),stamp=day=>model.utcBoundary(day).slice(0,19).replace('T',' ');
 async function insert(table,rows){const keys=Object.keys(rows[0]);await db.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES ${rows.map(()=>`(${keys.map(()=>'?').join(',')})`).join(',')}`,rows.flatMap(row=>keys.map(k=>row[k])));}
 stage='synthetic fixtures';
 await insert('campuses',[{id:a,organization_id:org,name:'Synthetic A',slug:'synthetic-a',status:'ACTIVE'},{id:b,organization_id:org,name:'Synthetic B',slug:'synthetic-b',status:'ACTIVE'}]);
 await insert('church_financial_transactions',[
  {id:'ops_income',organization_id:org,campus_id:a,type:'INCOME',category:'Synthetic',description:'Fixture',amount:100.01,status:'PAID',payment_date:date},
  {id:'ops_expense',organization_id:org,campus_id:a,type:'EXPENSE',category:'Synthetic',description:'Fixture',amount:150.02,status:'PAID',payment_date:date},
  {id:'ops_pending',organization_id:org,campus_id:a,type:'INCOME',category:'Synthetic',description:'Fixture',amount:20,status:'PENDING',payment_date:date},
  {id:'ops_cancel',organization_id:org,campus_id:a,type:'INCOME',category:'Synthetic',description:'Fixture',amount:999,status:'CANCELLED',payment_date:date},
  {id:'ops_previous',organization_id:org,campus_id:a,type:'INCOME',category:'Synthetic',description:'Fixture',amount:10,status:'PAID',payment_date:past},
  {id:'ops_denied_campus',organization_id:org,campus_id:b,type:'INCOME',category:'Synthetic',description:'Fixture',amount:77777,status:'PAID',payment_date:date},
  {id:'ops_other_tenant',organization_id:other,campus_id:a,type:'INCOME',category:'Synthetic',description:'Fixture',amount:88888,status:'PAID',payment_date:date}]);
 await insert('events',[{id:'ops_event',organization_id:org,campus_id:a,title:'Synthetic event',start_date:date+' 12:00:00',end_date:date+' 15:00:00',status:'FINISHED'}]);
 await insert('event_lots',[{id:'ops_lot_a',event_id:'ops_event',name:'Synthetic A',price:0,total_capacity:10,available_capacity:9},{id:'ops_lot_b',event_id:'ops_event',name:'Synthetic B',price:0,total_capacity:20,available_capacity:19}]);
 await insert('event_tickets',['USED','PAID','CANCELED','PENDING'].map((status,i)=>({id:'ops_ticket_'+i,organization_id:org,event_id:'ops_event',lot_id:'ops_lot_a',user_id:'synthetic',status,qrcode_token:'ops_qr_'+i,price_paid:0,scanned_at:status==='USED'?stamp(date):null})));
 await insert('pdv_products',[{id:'ops_product',organization_id:org,campus_id:a,name:'Synthetic product',price:10,status:'ACTIVE',track_inventory:1},{id:'ops_product2',organization_id:org,campus_id:a,name:'Synthetic product 2',price:10,status:'ACTIVE',track_inventory:1}]);
 await insert('pdv_orders',[
  {id:'ops_order',organization_id:org,campus_id:a,user_id:'synthetic',user_name:'Fixture',status:'FINALIZADO',payment_status:'PAID',items_json:'[]',total_price:30,paid_at:stamp(date)},
  {id:'ops_unknown_date',organization_id:org,campus_id:a,user_id:'synthetic',user_name:'Fixture',status:'FINALIZADO',payment_status:'PAID',items_json:'[]',total_price:999,paid_at:null},
  {id:'ops_cancelled_order',organization_id:org,campus_id:a,user_id:'synthetic',user_name:'Fixture',status:'CANCELADO',payment_status:'PAID',items_json:'[]',total_price:999,paid_at:stamp(date)}]);
 await insert('pdv_order_items',[{id:'ops_item1',organization_id:org,campus_id:a,order_id:'ops_order',product_id:'ops_product',product_name:'Fixture',quantity:2,unit_price:10,line_total:20},{id:'ops_item2',organization_id:org,campus_id:a,order_id:'ops_order',product_id:'ops_product2',product_name:'Fixture',quantity:1,unit_price:10,line_total:10}]);
 await insert('pdv_inventory_balances',[{id:'ops_balance',organization_id:org,campus_id:a,product_id:'ops_product',on_hand_quantity:4,reserved_quantity:3,minimum_stock:2}]);
 await insert('ministries',[{id:'ops_ministry',organization_id:org,campus_id:a,name:'Synthetic team',slug:'synthetic-team',status:'ACTIVE'}]);
 await insert('ministry_roles',[{id:'ops_role1',organization_id:org,ministry_id:'ops_ministry',name:'Synthetic A',min_volunteers:2},{id:'ops_role2',organization_id:org,ministry_id:'ops_ministry',name:'Synthetic B',min_volunteers:3}]);
 await insert('service_schedules',[{id:'ops_schedule',organization_id:org,campus_id:a,ministry_id:'ops_ministry',title:'Synthetic service',service_date:date,service_time:'10:00',status:'PUBLISHED'}]);
 await insert('service_roster_items',Array.from({length:5},(_,i)=>({id:'ops_roster_'+i,organization_id:org,schedule_id:'ops_schedule',role_id:i===4?'ops_role2':'ops_role1',member_id:'ops_member_'+i,status:'ACCEPTED'})));
 await insert('kids_rooms',[{id:'ops_room',organization_id:org,campus_id:a,name:'Synthetic room',min_age:0,max_age:10,capacity:10}]);
 await insert('kids_checkins',Array.from({length:3},(_,i)=>({id:'ops_checkin_'+i,organization_id:org,campus_id:a,child_id:'synthetic-child',child_name:'Synthetic fixture',room_id:'ops_room',room_name:'Synthetic room',parent_name:'Synthetic fixture',parent_phone:'00000000000',security_code:'ops_'+i,status:i===0?'CHECKED_OUT':'CHECKED_IN',checkin_at:stamp(i===2?past:date)})));
 // Gap and end-boundary records must not enter the prior MTD slice or today's incomplete day.
 await insert('church_financial_transactions',[{id:'ops_today',organization_id:org,campus_id:a,type:'INCOME',category:'Synthetic',description:'Fixture today excluded',amount:123.45,status:'PAID',payment_date:today}]);
 await insert('events',[{id:'ops_gap_event',organization_id:org,campus_id:a,title:'Synthetic gap event',start_date:past+' 12:00:00',end_date:past+' 15:00:00',status:'FINISHED'}]);
 await insert('pdv_orders',[{id:'ops_gap_order',organization_id:org,campus_id:a,user_id:'synthetic',user_name:'Fixture',status:'FINALIZADO',payment_status:'PAID',items_json:'[]',total_price:7.50,paid_at:stamp(past)}]);
 await insert('pdv_order_items',[{id:'ops_gap_item',organization_id:org,campus_id:a,order_id:'ops_gap_order',product_id:'ops_product',product_name:'Fixture',quantity:3,unit_price:2.50,line_total:7.50}]);
 await insert('service_schedules',[{id:'ops_gap_schedule',organization_id:org,campus_id:a,ministry_id:'ops_ministry',title:'Synthetic gap service',service_date:past,service_time:'10:00',status:'PUBLISHED'}]);
 const user={role:'ADMIN',userId:'ops_admin',organizationId:org,campusIds:[a,b],isSuperAdmin:false,operationalPermissions:[]},scope={user,organizationId:org,campusId:null,campusIds:[a,b],cellIds:null};
 stage='source SQL';const result=await intelligenceOperations(scope,'7d','units');assert.deepEqual(result.errors,[],JSON.stringify(result.errors));
 const values=key=>Object.fromEntries(result.sources[key].metrics.map(m=>[m.key,m.value]));
 assert.deepEqual(values('finance'),{income:10001,expense:15002,result:-5001,pending_income:2000,pending_expense:0,cancelled:1});
 assert.equal(result.sources.finance.metrics[0].previous,1000);assert.equal(result.sources.finance.metrics.find(m=>m.key==='result').change.percent,null);
 assert.deepEqual(values('events'),{events:1,tickets:2,checked_tickets:1,cancelled_tickets:1,ticket_capacity:30});
 assert.deepEqual(values('store'),{paid_orders:1,sales:3000,average_ticket:3000,sold_units:3,undated_orders:1});assert.equal(values('stock').low_stock,1);
 assert.deepEqual(values('teams'),{schedules:1,required_slots:5,accepted_slots:5,uncovered_slots:2});
 assert.deepEqual(values('kids'),{kids_checkins:2,kids_open:2,kids_capacity:10});
 assert.equal(result.units[1].sources.finance.status,'not_available');assert.equal(result.units[1].sources.kids.status,'not_available');
 assert.equal(JSON.stringify(result).includes('synthetic-child'),false);assert.equal(JSON.stringify(result).includes('parent_phone'),false);
 stage='month-to-date boundary regression';
 const month=await intelligenceOperations(scope,'month','units');assert.deepEqual(month.errors,[]);
 const gap=past>=month.period.previousEnd&&past<month.period.start;
 if(gap){
  // The -9-day fixtures are in the gap, not in the prior MTD comparison window.
  assert.equal(month.sources.finance.metrics.find(m=>m.key==='income').previous,0,'Prior MTD must exclude late-month ledger records');
  assert.equal(month.sources.events.metrics.find(m=>m.key==='events').previous,0,'Prior MTD must exclude late-month event editions');
  assert.equal(month.sources.store.metrics.find(m=>m.key==='sales').previous,0,'Prior MTD must exclude late-month paid orders');
  assert.equal(month.sources.teams.metrics.find(m=>m.key==='schedules').previous,0,'Prior MTD must exclude late-month services');
  assert.equal(month.sources.kids.metrics.find(m=>m.key==='kids_checkins').previous,0,'Prior MTD must exclude late-month Kids records');
 }
 stage='treasurer';const treasury=await intelligenceOperations({...scope,user:{...user,role:'TREASURER'}},'7d','units');assert.equal(treasury.sources.kids.status,'not_available');assert.equal(treasury.sources.events.status,'not_available');assert.equal(treasury.sources.finance.status,'available');
 console.log(JSON.stringify({passed:true,temporaryTablesOnly:true,customerRecordsRead:false,customerRecordsChanged:false,checks:['integer cents and signed result','cancelled/pending separation','tenant and campus source flag isolation','event multi-lot/ticket fanout','PDV item fanout and missing payment dates','stock availability','per-role vacancies with surplus isolation','Kids counts without identities','treasury scope','exact MTD windows in all five historical sources','incomplete current day exclusion']}));
})().catch(e=>{console.error(stage+': '+e.message);process.exitCode=1;}).finally(async()=>{if(db)await db.end();});
