import {createHash,randomUUID} from 'crypto';
import {query,getConnection} from '../db';
import {IntelligenceScope,scopedWhere} from './intelligenceScope';
import {IntelligenceError} from './intelligenceUsage';
import {safeIdentifier,dayInSaoPaulo,utcBoundary} from './intelligenceModel';
import {GOAL_METRICS,requireDay,requireVersion,shortTitle,assertActionTransition} from './intelligenceJourneyModel';
import {normalizeRole} from './authMiddleware';
import {logSecurityEvent} from './auditLogService';

type Executor={query:(sql:string,params?:any[])=>Promise<any>};
async function selectedContext(scope:IntelligenceScope,campus:string,cellId:string|null,ownerId:string,db:Executor){
 if(!safeIdentifier(campus)||!safeIdentifier(ownerId)||(cellId!==null&&!safeIdentifier(cellId)))throw new IntelligenceError(400,'Selecione unidade, responsável e grupo válidos.');
 if(scope.campusIds&&!scope.campusIds.includes(campus))throw new IntelligenceError(403,'Unidade fora do seu escopo.');
 if(scope.cellIds&&(!cellId||!scope.cellIds.includes(cellId)))throw new IntelligenceError(403,'Selecione um dos seus grupos.');
 const [campuses]:any=await db.query('SELECT id FROM campuses WHERE organization_id = ? AND id = ?',[scope.organizationId,campus]);
 if(!campuses.length)throw new IntelligenceError(404,'Unidade não encontrada.');
 let cell:any=null;
 if(cellId){const [cells]:any=await db.query("SELECT id,leader_id FROM cell_groups WHERE organization_id = ? AND COALESCE(campus_id,'campus_sede') = ? AND id = ?",[scope.organizationId,campus,cellId]);cell=cells[0];if(!cell)throw new IntelligenceError(404,'Grupo não encontrado nesta unidade.');}
 const [owners]:any=await db.query(`SELECT id,role,campus_id,campus_ids FROM members WHERE organization_id = ? AND id = ? AND UPPER(status) IN ('ACTIVE','ATIVO') LIMIT 1`,[scope.organizationId,ownerId]);
 const owner=owners[0];if(!owner||!['SUPERADMIN','PASTOR','ADMIN','LEADER'].includes(normalizeRole(owner.role)))throw new IntelligenceError(400,'Responsável precisa ser um líder, pastor ou administrador ativo desta igreja.');
 let ids:any;try{ids=typeof owner.campus_ids==='string'?JSON.parse(owner.campus_ids):owner.campus_ids;}catch{ids=[];}if(!Array.isArray(ids)||!ids.length)ids=[owner.campus_id||'campus_sede'];
 if(normalizeRole(owner.role)!=='SUPERADMIN'&&!ids.includes('all')&&!ids.includes(campus))throw new IntelligenceError(400,'O responsável não tem acesso à unidade.');
 if(normalizeRole(owner.role)==='LEADER'&&(!cell||cell.leader_id!==ownerId))throw new IntelligenceError(400,'O líder responsável deve conduzir o grupo selecionado.');
 return {campus,cellId};
}
export async function actionOptions(scope:IntelligenceScope,flags:Record<string,boolean>={}){
 const campus=scopedWhere({...scope,cellIds:null},'c','id'),cell=scopedWhere(scope,'cg','campus_id','id'),member=scopedWhere({...scope,cellIds:null},'m');
 const {rows:campuses}=await query(`SELECT c.id,c.name FROM campuses c WHERE c.organization_id = ?${campus.sql} ORDER BY c.name LIMIT 100`,[scope.organizationId,...campus.params]);
 const {rows:cells}=flags['cell_groups.module_enabled']?await query(`SELECT cg.id,cg.name,cg.campus_id,cg.leader_id FROM cell_groups cg WHERE cg.organization_id = ?${cell.sql} ORDER BY cg.name LIMIT 200`,[scope.organizationId,...cell.params]):{rows:[]};
 const {rows:owners}=scope.cellIds?await query(`SELECT m.id,m.name,m.role,m.campus_id FROM members m
 WHERE m.organization_id = ? AND m.id = ? AND UPPER(m.status) IN ('ACTIVE','ATIVO')${member.sql}`,[scope.organizationId,scope.user.userId,...member.params])
 :await query(`SELECT m.id,m.name,m.role,m.campus_id FROM members m WHERE m.organization_id = ?
 AND UPPER(m.status) IN ('ACTIVE','ATIVO') AND UPPER(m.role) IN ('SUPERADMIN','PASTOR','ADMIN','LEADER','LIDER')${member.sql} ORDER BY m.name LIMIT 200`,[scope.organizationId,...member.params]);
 return {campuses,cells,owners,metrics:Object.fromEntries(Object.entries(GOAL_METRICS).filter(([key,value])=>flags[value.flag]&&(!key.startsWith('visitors_')||flags['intelligence.member_journey'])))};
}
async function subjectContext(scope:IntelligenceScope,type:string,id:string,flags:Record<string,boolean>,db:Executor){
 if(!safeIdentifier(id))throw new IntelligenceError(400,'Origem inválida.');
 if(type==='visitor'){
  if(!flags['visitors.module_enabled']||!flags['intelligence.member_journey'])throw new IntelligenceError(403,'Acolhimento não está disponível neste plano ou escopo.');
  const f=scopedWhere(scope,'v','campus_id','assigned_cell_id');const [rows]:any=await db.query(`SELECT v.campus_id,v.assigned_cell_id FROM church_visitors v WHERE v.organization_id = ? AND v.id = ?${f.sql} LIMIT 1`,[scope.organizationId,id,...f.params]);
  if(!rows.length)throw new IntelligenceError(404,'Origem não encontrada.');return {campus:rows[0].campus_id,cellId:rows[0].assigned_cell_id||null,tab:'visitantes'};
 }
 if(type==='cell'){
  if(!flags['cell_groups.module_enabled'])throw new IntelligenceError(403,'Células não estão disponíveis neste plano.');
  const f=scopedWhere(scope,'cg','campus_id','id');const [rows]:any=await db.query(`SELECT cg.id,cg.campus_id FROM cell_groups cg WHERE cg.organization_id = ? AND cg.id = ?${f.sql} LIMIT 1`,[scope.organizationId,id,...f.params]);
  if(!rows.length)throw new IntelligenceError(404,'Origem não encontrada.');return {campus:rows[0].campus_id,cellId:rows[0].id,tab:'celulas'};
 }
 if(type==='metric'&&['activation','data_quality'].includes(id)){
  if(id==='activation'&&!flags['intelligence.activation'])throw new IntelligenceError(403,'Ativação não está disponível.');
  return null;
 }
 throw new IntelligenceError(400,'Use uma origem de acolhimento, célula ou indicador disponível.');
}

export async function listActions(scope:IntelligenceScope,flags:Record<string,boolean>,page=0,status='all'){
 if(!Number.isInteger(page)||page<0||page>100)throw new IntelligenceError(400,'Página inválida.');
 if(!['all','open','closed','snoozed'].includes(status))throw new IntelligenceError(400,'Filtro de situação inválido.');
 const f=scopedWhere(scope,'a','campus_id','cell_group_id');
 const parentFilter=`${flags['visitors.module_enabled']&&flags['intelligence.member_journey']?'':" AND a.subject_type <> 'visitor'"}${flags['cell_groups.module_enabled']?'':" AND a.subject_type <> 'cell'"}`;
 const statusFilter=status==='open'?" AND a.closed_at IS NULL AND (a.snoozed_until IS NULL OR a.snoozed_until <= ?)":status==='closed'?" AND a.closed_at IS NOT NULL":status==='snoozed'?" AND a.closed_at IS NULL AND a.snoozed_until > ?":'';
 const {rows}=await query(`SELECT a.*,m.name AS owner_name,DATE_FORMAT(a.created_at,'%Y-%m-%dT%H:%i:%s.000Z') AS created_at,
 DATE_FORMAT(a.updated_at,'%Y-%m-%dT%H:%i:%s.000Z') AS updated_at,DATE_FORMAT(a.due_date,'%Y-%m-%d') AS due_date,
 DATE_FORMAT(a.snoozed_until,'%Y-%m-%d') AS snoozed_until FROM intelligence_actions a
 LEFT JOIN members m ON m.organization_id = a.organization_id AND m.id = a.owner_id
 WHERE a.organization_id = ?${f.sql}${parentFilter}${statusFilter} ORDER BY a.closed_at IS NOT NULL,a.due_date,a.id LIMIT 101 OFFSET ?`,[scope.organizationId,...f.params,...(['open','snoozed'].includes(status)?[dayInSaoPaulo()]:[]),page*100]);
 const actions=rows.slice(0,100).map(row=>({...row,version:Number(row.version),source_available:row.subject_type!=='visitor'||!!(flags['visitors.module_enabled']&&flags['intelligence.member_journey']),
  source_tab:row.subject_type==='visitor'?'visitantes':row.subject_type==='cell'?'celulas':'intelligence'}));
 return {actions,has_more:rows.length>100,page};
}
export async function saveAction(scope:IntelligenceScope,flags:Record<string,boolean>,body:any,event:any,id?:string){
 const db=await getConnection();try{await db.beginTransaction();const org=scope.organizationId;
 if(id){
  if(!safeIdentifier(id))throw new IntelligenceError(400,'Ação inválida.');const f=scopedWhere(scope,'a','campus_id','cell_group_id');
  const [rows]:any=await db.query(`SELECT a.* FROM intelligence_actions a WHERE a.organization_id = ? AND a.id = ?${f.sql} LIMIT 1 FOR UPDATE`,[org,id,...f.params]);
  if(!rows.length)throw new IntelligenceError(404,'Ação não encontrada.');const previous=rows[0];
  if((previous.subject_type==='visitor'&&(!flags['visitors.module_enabled']||!flags['intelligence.member_journey']))||(previous.subject_type==='cell'&&!flags['cell_groups.module_enabled']))throw new IntelligenceError(403,'O módulo de origem não está disponível no plano.');
  if(requireVersion(body.expected_version)!==Number(previous.version))throw new IntelligenceError(409,'A ação foi atualizada. Recarregue antes de salvar.');
  const status=body.status||previous.status;assertActionTransition(previous.status,status,body.resolution||previous.resolution);
  const owner=body.owner_id||previous.owner_id,due=body.due_date?requireDay(body.due_date):String(previous.due_date instanceof Date?previous.due_date.toISOString().slice(0,10):previous.due_date);
  await selectedContext(scope,previous.campus_id,previous.cell_group_id,owner,db);
  let snooze=['COMPLETED','DISMISSED'].includes(status)?null:body.snoozed_until?requireDay(body.snoozed_until):null;
  if(snooze&&snooze<dayInSaoPaulo())snooze=null;
  if(snooze&&Date.parse(snooze)-Date.parse(dayInSaoPaulo())>30*86400000)throw new IntelligenceError(400,'Adie somente ações abertas, por até 30 dias.');
  const resolution=['COMPLETED','DISMISSED'].includes(status)?body.resolution||previous.resolution:null;
  await db.query(`UPDATE intelligence_actions SET status = ?,owner_id = ?,due_date = ?,snoozed_until = ?,resolution = ?,version = version + 1,
   closed_at = IF(? IN ('COMPLETED','DISMISSED'),UTC_TIMESTAMP(),NULL),updated_at = UTC_TIMESTAMP() WHERE organization_id = ? AND id = ?`,[status,owner,due,snooze,resolution,status,org,id]);
  await logSecurityEvent({organizationId:org,campusId:previous.campus_id,user:scope.user,action:'INTELLIGENCE_ACTION_UPDATED',resource:'intelligence_actions',resourceId:id,
   details:{previousStatus:previous.status,status,resolution,version:Number(previous.version)+1},event,strict:true,executor:(s,p)=>db.query(s,p)});
  await db.commit();return {id,version:Number(previous.version)+1,status};
 }
 const title=shortTitle(body.title),due=requireDay(body.due_date);
 if(!safeIdentifier(body.request_id))throw new IntelligenceError(400,'Identificador de solicitação inválido.');
 const type=body.subject_type,subject=await subjectContext(scope,type,body.subject_id,flags,db);
 const campus=subject?.campus||body.campus_id,cellId=subject?.cellId||body.cell_group_id||null;
 await selectedContext(scope,campus,cellId,body.owner_id,db);
 if(body.signal_key&&(body.signal_key!=='welcome_waiting'||type!=='visitor'))throw new IntelligenceError(400,'Sinal de acompanhamento inválido.');
 const dedup=body.signal_key?`welcome_waiting_${dayInSaoPaulo().slice(0,7)}`:String(body.request_id);
 // Signal identity is bound to its origin and scope; arbitrary client text never widens deduplication.
 const key=createHash('sha256').update(`${org}:${campus}:${cellId||''}:${type}:${body.subject_id}:${dedup}`).digest('hex');
 const requestHash=createHash('sha256').update(JSON.stringify([title,due,campus,cellId,type,body.subject_id,body.owner_id,scope.user.userId])).digest('hex');
 const actionId=randomUUID();
 const [insert]:any=await db.query(`INSERT IGNORE INTO intelligence_actions(organization_id,id,campus_id,cell_group_id,subject_type,subject_id,owner_id,created_by,title,due_date,dedup_key,request_hash,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())`,[org,actionId,campus,cellId,type,body.subject_id,body.owner_id,scope.user.userId,title,due,key,requestHash]);
 if(!insert.affectedRows){
  const [existing]:any=await db.query('SELECT id,request_hash FROM intelligence_actions WHERE organization_id = ? AND dedup_key = ?',[org,key]);
  if(!existing.length)throw new IntelligenceError(409,'Ação já registrada. Atualize os dados.');
  if(!body.signal_key&&existing[0].request_hash!==requestHash)throw new IntelligenceError(409,'A solicitação já foi utilizada por outra ação.');
  await db.commit();return {id:existing[0].id,already_exists:true};
 }
 await logSecurityEvent({organizationId:org,campusId:campus,user:scope.user,action:'INTELLIGENCE_ACTION_CREATED',resource:'intelligence_actions',resourceId:actionId,
  details:{subjectType:type,subjectId:body.subject_id,ownerId:body.owner_id},event,strict:true,executor:(s,p)=>db.query(s,p)});
 await db.commit();return {id:actionId,version:0,status:'NEW'};
 }catch(error){await db.rollback();throw error;}finally{db.release();}
}

export async function listGoals(scope:IntelligenceScope,flags:Record<string,boolean>,page=0){
 if(!Number.isInteger(page)||page<0||page>100)throw new IntelligenceError(400,'Página inválida.');
 const f=scopedWhere(scope,'g','campus_id','cell_group_id');
 const {rows}=await query(`SELECT g.*,m.name AS owner_name,DATE_FORMAT(g.start_date,'%Y-%m-%d') AS start_date,DATE_FORMAT(g.end_date,'%Y-%m-%d') AS end_date
 FROM intelligence_goals g LEFT JOIN members m ON m.organization_id = g.organization_id AND m.id = g.owner_id
 WHERE g.organization_id = ?${f.sql} ORDER BY g.status <> 'ACTIVE',g.end_date DESC,g.id LIMIT 21 OFFSET ?`,[scope.organizationId,...f.params,page*20]);
 const goals=[];
 for(const row of rows.slice(0,20)){
  const definition=GOAL_METRICS[row.metric];
  let value:number|null=null,sourceStatus='not_available';
  if(definition&&flags[definition.flag]){
   const narrowed={...scope,campusIds:[row.campus_id],cellIds:row.cell_group_id?[row.cell_group_id]:null};
   const start=utcBoundary(row.start_date).slice(0,19).replace('T',' '),endDate=new Date(row.end_date+'T12:00:00Z');endDate.setUTCDate(endDate.getUTCDate()+1);
   const end=utcBoundary(endDate.toISOString().slice(0,10)).slice(0,19).replace('T',' ');
   try{
    if(row.metric==='registered_participants'){
     const filter=scopedWhere(narrowed,'cm','campus_id','cell_group_id');
     const result=await query(`SELECT COUNT(DISTINCT ca.member_id) AS total FROM cell_meeting_attendees ca
     INNER JOIN cell_meetings cm ON cm.organization_id = ca.organization_id AND cm.id = ca.meeting_id
     WHERE ca.organization_id = ? AND ca.status = 'PRESENT' AND cm.meeting_date >= ? AND cm.meeting_date <= ?${filter.sql}`,[scope.organizationId,row.start_date,row.end_date,...filter.params]);value=Number(result.rows[0]?.total||0);
    }else if(flags['intelligence.member_journey']){
     const column=row.metric==='visitors_contacted'?'contacted_at':'linked_at',filter=scopedWhere(narrowed,'v','campus_id','assigned_cell_id');
     const result=await query(`SELECT COUNT(DISTINCT v.id) AS total FROM church_visitors v
     INNER JOIN intelligence_welcome_state w ON w.organization_id = v.organization_id AND w.visitor_id = v.id
     WHERE v.organization_id = ? AND w.${column} >= ? AND w.${column} < ?${filter.sql}`,[scope.organizationId,start,end,...filter.params]);value=Number(result.rows[0]?.total||0);
    }
    sourceStatus=value===null?'not_available':'registered_records';
   }catch{sourceStatus='error';}
  }
  goals.push({...row,target_count:Number(row.target_count),version:Number(row.version),value,source_status:sourceStatus,percent:value===null?null:Math.round(value/Number(row.target_count)*1000)/10,metric_label:definition?.label||row.metric,
   coverage_note:row.metric.startsWith('visitors_')?'Somente marcos registrados nesta instrumentação; o histórico anterior pode ter cobertura parcial.':'Presenças lançadas; não representa cobertura de um calendário completo.'});
 }
 return {goals,has_more:rows.length>20,page,limit:20,definitions:['Progresso usa registros verificáveis no período da meta e no escopo atual. Correções nas fontes podem revisar o total.','Atingir a quantidade não prova resultado pastoral ou efeito causado por uma ação. Ausência de registro não comprova ausência de atividade.']};
}
export async function saveGoal(scope:IntelligenceScope,flags:Record<string,boolean>,body:any,event:any,id?:string){
 const db=await getConnection();try{await db.beginTransaction();const org=scope.organizationId;
 if(id){
  if(!safeIdentifier(id))throw new IntelligenceError(400,'Meta inválida.');const f=scopedWhere(scope,'g','campus_id','cell_group_id');
  const [rows]:any=await db.query(`SELECT g.* FROM intelligence_goals g WHERE g.organization_id = ? AND g.id = ?${f.sql} LIMIT 1 FOR UPDATE`,[org,id,...f.params]);
  if(!rows.length)throw new IntelligenceError(404,'Meta não encontrada.');const previous=rows[0];
  if(requireVersion(body.expected_version)!==Number(previous.version))throw new IntelligenceError(409,'A meta foi alterada. Atualize antes de salvar.');
  if(!['ACTIVE','COMPLETED','CANCELLED'].includes(body.status))throw new IntelligenceError(400,'Situação de meta inválida.');
  await db.query('UPDATE intelligence_goals SET status = ?,version = version + 1,updated_at = UTC_TIMESTAMP() WHERE organization_id = ? AND id = ?',[body.status,org,id]);
  await logSecurityEvent({organizationId:org,campusId:previous.campus_id,user:scope.user,action:'INTELLIGENCE_GOAL_UPDATED',resource:'intelligence_goals',resourceId:id,details:{previousStatus:previous.status,status:body.status,version:Number(previous.version)+1},event,strict:true,executor:(s,p)=>db.query(s,p)});
  await db.commit();return {id,version:Number(previous.version)+1};
 }
 const definition=GOAL_METRICS[body.metric];if(!definition||!flags[definition.flag]||(body.metric.startsWith('visitors_')&&!flags['intelligence.member_journey']))throw new IntelligenceError(403,'Indicador não disponível para esta meta.');
 const title=shortTitle(body.title),start=requireDay(body.start_date),end=requireDay(body.end_date);
 if(start>end||Date.parse(end)-Date.parse(start)>365*86400000||!Number.isInteger(body.target_count)||body.target_count<1||body.target_count>100000)throw new IntelligenceError(400,'Defina uma quantidade de 1 a 100.000 e um período de até 366 dias.');
 await selectedContext(scope,body.campus_id,body.cell_group_id||null,body.owner_id,db);
 // Client-generated UUID provides idempotency for submission retries; never accept arbitrary tenant IDs in the identifier.
 if(typeof body.request_id!=='string'||!/^[0-9a-f-]{36}$/i.test(body.request_id))throw new IntelligenceError(400,'Identificador da meta inválido.');
 const goalId=body.request_id;
 const requestHash=createHash('sha256').update(JSON.stringify([body.campus_id,body.cell_group_id||null,body.metric,body.owner_id,title,body.target_count,start,end,scope.user.userId])).digest('hex');
 const [insert]:any=await db.query(`INSERT IGNORE INTO intelligence_goals(organization_id,id,campus_id,cell_group_id,metric,owner_id,title,target_count,start_date,end_date,created_by,request_hash,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())`,[org,goalId,body.campus_id,body.cell_group_id||null,body.metric,body.owner_id,title,body.target_count,start,end,scope.user.userId,requestHash]);
 if(!insert.affectedRows){const [old]:any=await db.query('SELECT request_hash FROM intelligence_goals WHERE organization_id = ? AND id = ?',[org,goalId]);if(!old.length||old[0].request_hash!==requestHash)throw new IntelligenceError(409,'Identificador já utilizado.');await db.commit();return {id:goalId,already_exists:true};}
 await logSecurityEvent({organizationId:org,campusId:body.campus_id,user:scope.user,action:'INTELLIGENCE_GOAL_CREATED',resource:'intelligence_goals',resourceId:goalId,
 details:{metric:body.metric,targetCount:body.target_count,start,end},event,strict:true,executor:(s,p)=>db.query(s,p)});
 await db.commit();return {id:goalId,version:0};
 }catch(error){await db.rollback();throw error;}finally{db.release();}
}
