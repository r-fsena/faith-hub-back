// Invoked only inside the existing TEMPORARY-table integration connection.
const assert=require('node:assert/strict');
module.exports=async({db,org,other,campus,person,user,scope,flags,model})=>{
 const {activationFunnel,communityJourney}=require('../src/services/intelligenceJourneys.ts');
 const {mutateWelcome,trackNewWelcome,welcomeOptions,listWelcomeVisitors}=require('../src/services/intelligenceWelcome.ts');
 const {saveAction,listActions,saveGoal,listGoals}=require('../src/services/intelligenceActions.ts');
 const {recordInvitationMilestone}=require('../src/services/intelligenceInvitation.ts');
 for(const key of Object.keys(require('../migrate_intelligence_journeys.js').additions))flags[key]=true;
 const today=model.dayInSaoPaulo(),shift=days=>new Date(Date.parse(today+'T12:00:00Z')+days*86400000).toISOString().slice(0,10),stamp=day=>model.utcBoundary(day).slice(0,19).replace('T',' ');
 const cell='fixture_journey_cell',visitor='fixture_journey_visitor',event={headers:{'x-organization-id':org},requestContext:{requestId:'journey-fixture'}};
 await db.query("UPDATE members SET role = 'ADMIN',campus_ids = ? WHERE organization_id = ? AND id = ?",[JSON.stringify([campus]),org,person]);
 await db.query("INSERT INTO cell_groups(id,organization_id,campus_id,name,leader_id) VALUES(?,?,?,'Synthetic journey cell',?)",[cell,org,campus,person]);
 await db.query('UPDATE members SET cell_group_id = ? WHERE organization_id = ?',[cell,org]);
 await db.query('INSERT INTO intelligence_fixture_leaders SELECT * FROM members');
 await recordInvitationMilestone(org,person,'CSV','REGISTERED',event,true);
 await recordInvitationMilestone(org,person,'CSV','REQUESTED',event,true);
 await recordInvitationMilestone(org,person,'CSV','REQUESTED',event,true);
 let [rows]=await db.query('SELECT COUNT(*) AS count FROM intelligence_invitation_events WHERE organization_id = ?',[org]);assert.equal(Number(rows[0].count),2,'Same operational request is recorded once');
 for(let n=1;n<12;n++){
  const id=`int_fixture_member_${n}`;
  await db.query(`INSERT INTO intelligence_invitation_events(organization_id,id,user_id,campus_id,source,outcome,occurred_at) VALUES(?,?,?,?, 'CSV','REQUESTED',?)`,[org,String(n).padStart(64,'0'),id,campus,stamp(shift(-15))]);
  await db.query(`INSERT INTO intelligence_consent(organization_id,user_id,allowed,policy_version,revision) VALUES(?,?,1,?,1)`,[org,id,model.INTELLIGENCE_VERSION]);
  for(const day of [shift(-14),shift(-12)])await db.query(`INSERT INTO intelligence_activity_daily(organization_id,campus_id,activity_date,subject_key,session_key,module,experience_version,actor_kind,cell_group_id,interactions,first_at,last_at)
   VALUES(?,?,?,?,?,'home','v2','member',?,1,?,?)`,[org,campus,day,model.subjectKey(org,id),(String(n)+day).padEnd(64,'0'),cell,stamp(day),stamp(day)]);
  await db.query(`INSERT INTO content_engagement_events(id,organization_id,campus_id,user_id,session_hash,content_type,content_id,event_type,source,idempotency_key,occurred_at)
   VALUES(?,?,?,?,?,'DEVOTIONAL','int_fixture_devotional','COMPLETED','PWA_INTELLIGENCE_V1',?,?)`,['journey_value_'+n,org,campus,id,String(n).padStart(64,'0'),'journey_key_'+n,stamp(shift(-14))]);
 }
 await db.query('INSERT INTO intelligence_fixture_return SELECT * FROM intelligence_activity_daily');
 const activation=await activationFunnel(scope,flags,'30d');
 const cohort=activation.cohorts.find(c=>c.invited===11);assert.ok(cohort,'Mature invitation cohort must exist');assert.equal(cohort.measured_access,11);assert.equal(cohort.qualified_use,11);assert.equal(cohort.returned,11);assert.equal(cohort.return_percent,100);
 const firstVisit=shift(-15),linked='int_fixture_member_1';
 await db.query(`INSERT INTO church_visitors(id,organization_id,campus_id,name,phone,stage,first_visit_date,assigned_cell_id,assigned_leader_id)
  VALUES(?,?,?,'Synthetic visitor','11999999999','NEW',?,?,?)`,[visitor,org,campus,firstVisit,cell,person]);
 await trackNewWelcome(db,org,visitor,campus,person,firstVisit);
 let [states]=await db.query('SELECT baseline_known FROM intelligence_welcome_state WHERE organization_id = ? AND visitor_id = ?',[org,visitor]);assert.equal(Number(states[0].baseline_known),0,'Backdated visitors cannot fabricate a complete cohort baseline');
 await assert.rejects(mutateWelcome(scope,visitor,{operation:'stage',stage:'ATTENDING_CELL',member_id:linked,expected_version:0},event),/presença/);
 let result=await mutateWelcome(scope,visitor,{operation:'stage',stage:'CONTACTED_24H',expected_version:0},event);assert.equal(result.journey_version,1);
 await assert.rejects(mutateWelcome(scope,visitor,{operation:'stage',stage:'ARCHIVED',expected_version:0},event),/alterada/);
 result=await mutateWelcome(scope,visitor,{operation:'link',member_id:linked,expected_version:1},event);assert.equal(result.journey_version,2);
 await db.query(`INSERT INTO cell_meetings(id,organization_id,campus_id,cell_group_id,leader_id,meeting_date) VALUES('journey_meeting',?,?,?,?,?)`,[org,campus,cell,person,shift(-1)]);
 await db.query(`INSERT INTO cell_meeting_attendees(id,organization_id,meeting_id,member_id,status) VALUES('journey_attendance',?,'journey_meeting',?,'PRESENT')`,[org,linked]);
 result=await mutateWelcome(scope,visitor,{operation:'stage',stage:'ATTENDING_CELL',member_id:linked,expected_version:2},event);assert.equal(result.journey_version,3);
 result=await mutateWelcome(scope,visitor,{operation:'stage',stage:'INTEGRATED_MEMBER',member_id:linked,expected_version:3},event);assert.equal(result.journey_version,4);
 const options=await welcomeOptions(scope,visitor);assert.equal(options.visitor.linked_member_id,linked);assert.equal(options.history.length,5);
 const community=await communityJourney(scope,'30d',7,flags);assert.equal(community.cohorts.reduce((sum,c)=>sum+c.unknown_history,0),1);assert.ok(community.participation.some(p=>p.participants===1));
 // A verified historical fixture represents a journey actually captured since its visit.
 await db.query(`INSERT INTO church_visitors(id,organization_id,campus_id,name,phone,stage,first_visit_date,assigned_cell_id) VALUES('journey_known',?,?,'Verified cohort fixture','11999999999','CONTACTED_24H',?,?)`,[org,campus,firstVisit,cell]);
 await db.query(`INSERT INTO intelligence_welcome_state(organization_id,visitor_id,baseline_known,tracked_since,contacted_at) VALUES(?,'journey_known',1,?,?)`,[org,stamp(firstVisit),stamp(shift(-14))]);
 let complete=await communityJourney(scope,'30d',7,flags);assert.equal(complete.cohorts.reduce((sum,c)=>sum+c.mature,0),1);assert.equal(complete.cohorts.reduce((sum,c)=>sum+c.contacted,0),1);
 for(const key of ['intelligence.member_journey','intelligence.usage_collection'])await db.query(`INSERT INTO tenant_feature_flags(id,organization_id,environment,feature_key,is_enabled,category,description,updated_by,updated_at)
 VALUES(?,?,'production',?,1,'Inteligência','Synthetic fixture only','fixture',UTC_TIMESTAMP())`,[key.endsWith('member_journey')?'journey_policy':'usage_policy',org,key]);
 complete=await communityJourney(scope,'30d',7,flags);assert.equal(complete.cohorts.reduce((sum,c)=>sum+c.mature,0),0,'Recent policy changes cannot fabricate complete cohort coverage');
 const pausedReturn=await activationFunnel(scope,flags,'30d');assert.equal(pausedReturn.cohorts.find(c=>c.invited===11).return_percent,null);
 await db.query('DELETE FROM tenant_feature_flags WHERE organization_id = ? AND id IN (?,?)',[org,'journey_policy','usage_policy']);
 await db.query("DELETE FROM church_visitors WHERE organization_id = ? AND id = 'journey_known'",[org]);await db.query("DELETE FROM intelligence_welcome_state WHERE organization_id = ? AND visitor_id = 'journey_known'",[org]);
 await db.query('INSERT INTO intelligence_fixture_meetings SELECT * FROM cell_meetings');
 const report=await require('../src/functions/pastoralCare.ts').getExecutiveReport({...event,queryStringParameters:{organization_id:org,campus_id:campus}});
 assert.equal(report.statusCode,200);assert.equal(Number(JSON.parse(report.body).cell_rankings[0].meetings_count_30d),1);
 const forbidden={...scope,organizationId:other};await assert.rejects(mutateWelcome(forbidden,visitor,{stage:'ARCHIVED',expected_version:4},event),/não encontrado/);
 const action={request_id:'journey-action',title:'Revisar acolhimento sintético',subject_type:'visitor',subject_id:visitor,owner_id:person,due_date:today,signal_key:'welcome_waiting'};
 let saved=await saveAction(scope,flags,action,event);const actionId=saved.id;assert.equal((await saveAction(scope,flags,action,event)).already_exists,true);
 let actions=await listActions(scope,flags);assert.equal(actions.actions.length,1);
 saved=await saveAction(scope,flags,{status:'IN_REVIEW',expected_version:0},event,actionId);assert.equal(saved.version,1);
 saved=await saveAction(scope,flags,{status:'COMPLETED',resolution:'RESOLVED',expected_version:1},event,actionId);assert.equal(saved.version,2);
 await assert.rejects(saveAction(scope,flags,{status:'IN_REVIEW',expected_version:1},event,actionId),/atualizada/);
 const goalBody={request_id:'d919d3d1-f085-43d2-84b2-f3c2fc72360d',title:'Contatos sintéticos registrados',campus_id:campus,cell_group_id:cell,owner_id:person,metric:'visitors_contacted',target_count:2,start_date:shift(-1),end_date:today};
 const createdGoal=await saveGoal(scope,flags,goalBody,event);assert.equal((await saveGoal(scope,flags,goalBody,event)).already_exists,true);
 await assert.rejects(saveGoal(scope,flags,{...goalBody,target_count:9},event),/utilizado/);
 const goals=await listGoals(scope,flags);assert.equal(goals.goals[0].value,1);assert.equal(goals.goals[0].percent,50);
 await saveGoal(scope,flags,{status:'COMPLETED',expected_version:0},event,createdGoal.id);
 await mutateWelcome(scope,visitor,{stage:'ARCHIVED',expected_version:4},event);assert.equal((await listWelcomeVisitors(scope)).visitors.length,0);
 assert.equal((await listWelcomeVisitors(scope,{stage:'ARCHIVED'})).visitors.length,1);
 await assert.rejects(mutateWelcome(scope,visitor,{stage:'CONTACTED_24H',expected_version:5},event),/Retome/);
 await mutateWelcome(scope,visitor,{stage:'NEW',expected_version:5},event);assert.equal((await listWelcomeVisitors(scope)).visitors.length,1);
 const noGroup={...scope,user:{...user,role:'LEADER'},cellIds:['not-owned']};assert.equal((await listActions(noGroup,flags)).actions.length,0);
 await assert.rejects(saveGoal(noGroup,flags,{...goalBody,request_id:'8d71dc7a-cb11-49ee-b652-19ddb8cd3a82'},event),/seus grupos/);
 console.log(JSON.stringify({journeysTemporaryTablesOnly:true,checks:['operational invite idempotency','adult authorized activation cohort and return SQL','backdated cohort exclusion','contact/link/presence/integration evidence and versioning','cross-tenant visitor denial','action audit, deduplication and state transitions','goal idempotency and source-backed progress','reversible archive','leader group isolation']}));
};
