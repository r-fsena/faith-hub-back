import {randomUUID} from 'crypto';
import {query,getConnection} from '../db';
import {IntelligenceScope,scopedWhere} from './intelligenceScope';
import {IntelligenceError} from './intelligenceUsage';
import {safeIdentifier,dayInSaoPaulo} from './intelligenceModel';
import {VISITOR_STAGES,requireVersion} from './intelligenceJourneyModel';
import {logSecurityEvent} from './auditLogService';

export async function listWelcomeVisitors(scope:IntelligenceScope,options:any={}){
 const filter=scopedWhere(scope,'v','campus_id','assigned_cell_id');
 const params:any[]=[scope.organizationId,...filter.params];let extra='';
 if(options.stage&&options.stage!=='ALL'){if(!VISITOR_STAGES.includes(options.stage))throw new IntelligenceError(400,'Etapa inválida.');extra+=' AND v.stage = ?';params.push(options.stage);}
 else extra+=" AND v.stage <> 'ARCHIVED'";
 if(options.id){if(!safeIdentifier(options.id))throw new IntelligenceError(400,'Visitante inválido.');extra+=' AND v.id = ?';params.push(options.id);}
 if(options.search){if(typeof options.search!=='string'||options.search.length>100)throw new IntelligenceError(400,'Busca inválida.');extra+=' AND (v.name LIKE ? OR v.phone LIKE ?)';params.push(`%${options.search}%`,`%${options.search}%`);}
 const page=Number(options.page||0);if(!Number.isInteger(page)||page<0||page>100)throw new IntelligenceError(400,'Página inválida.');
 const {rows}=await query(`SELECT v.*,cg.name AS cell_name,cg.meeting_day AS cell_day,cg.meeting_time AS cell_time,
 cg.neighborhood AS cell_neighborhood,leader.name AS leader_name,leader.phone AS leader_phone,
 DATEDIFF(CURRENT_DATE,v.first_visit_date) AS days_since_first_visit,COALESCE(w.version,0) AS journey_version,
 COALESCE(w.baseline_known,0) AS baseline_known,w.linked_member_id,
 DATE_FORMAT(w.contacted_at,'%Y-%m-%dT%H:%i:%s.000Z') AS contacted_at,
 DATE_FORMAT(w.linked_at,'%Y-%m-%dT%H:%i:%s.000Z') AS linked_at,
 DATE_FORMAT(w.attended_at,'%Y-%m-%dT%H:%i:%s.000Z') AS attended_at,
 DATE_FORMAT(w.integrated_at,'%Y-%m-%dT%H:%i:%s.000Z') AS integrated_at
 FROM church_visitors v LEFT JOIN cell_groups cg ON cg.organization_id = v.organization_id AND cg.id = v.assigned_cell_id
 LEFT JOIN members leader ON leader.organization_id = v.organization_id AND leader.id = v.assigned_leader_id
 LEFT JOIN intelligence_welcome_state w ON w.organization_id = v.organization_id AND w.visitor_id = v.id
 WHERE v.organization_id = ?${filter.sql}${extra} ORDER BY v.created_at DESC,v.id DESC LIMIT 101 OFFSET ?`,[...params,page*100]);
 return {visitors:rows.slice(0,100),has_more:rows.length>100,page};
}

export async function welcomeVisitor(scope:IntelligenceScope,id:string,executor?:any){
 if(!safeIdentifier(id))throw new IntelligenceError(400,'Visitante inválido.');
 const filter=scopedWhere(scope,'v','campus_id','assigned_cell_id');
 const sql=`SELECT v.* FROM church_visitors v WHERE v.organization_id = ? AND v.id = ?${filter.sql} LIMIT 1${executor?' FOR UPDATE':''}`;
 const params=[scope.organizationId,id,...filter.params];
 const rows=executor?(await executor.query(sql,params))[0]:(await query(sql,params)).rows;
 if(!rows.length)throw new IntelligenceError(404,'Visitante não encontrado no seu escopo.');return rows[0];
}

export async function welcomeOptions(scope:IntelligenceScope,id:string,search='',cellsEnabled=true){
 const visitor=await welcomeVisitor(scope,id);
 const cellScope=scopedWhere({...scope,campusIds:[visitor.campus_id]},'cg','campus_id','id');
 const {rows:cells}=cellsEnabled?await query(`SELECT cg.id,cg.name FROM cell_groups cg WHERE cg.organization_id = ?${cellScope.sql} ORDER BY cg.name LIMIT 100`,[scope.organizationId,...cellScope.params]):{rows:[]};
 let members:any[]=[];
 if(cellsEnabled&&visitor.assigned_cell_id){
 if(typeof search!=='string'||search.length>100)throw new IntelligenceError(400,'Busca inválida.');
 const result=await query(`SELECT id,name,RIGHT(TRIM(COALESCE(phone,'')),4) AS phone_suffix FROM members WHERE organization_id = ? AND COALESCE(campus_id,'campus_sede') = ? AND cell_group_id = ?
 AND UPPER(status) IN ('ACTIVE','ATIVO') AND UPPER(role) NOT IN ('VISITOR','VISITANTE') AND name LIKE ? ORDER BY name LIMIT 30`,[scope.organizationId,visitor.campus_id,visitor.assigned_cell_id,`%${search}%`]);members=result.rows;
 }
 const {rows:state}=await query('SELECT version,linked_member_id FROM intelligence_welcome_state WHERE organization_id = ? AND visitor_id = ?',[scope.organizationId,id]);
 const {rows:history}=await query(`SELECT kind,previous_stage,stage,version,DATE_FORMAT(occurred_at,'%Y-%m-%dT%H:%i:%s.000Z') AS occurred_at
 FROM intelligence_welcome_events WHERE organization_id = ? AND visitor_id = ? ORDER BY version DESC LIMIT 30`,[scope.organizationId,id]);
 return {cells_enabled:cellsEnabled,visitor:{id:visitor.id,name:visitor.name,stage:visitor.stage,campus_id:visitor.campus_id,assigned_cell_id:visitor.assigned_cell_id,
 journey_version:Number(state[0]?.version||0),linked_member_id:state[0]?.linked_member_id||null},cells,members,history,member_search_limited:true};
}

export async function mutateWelcome(scope:IntelligenceScope,id:string,body:any,event:any,tracking=true){
 const db=await getConnection();try{await db.beginTransaction();
 const visitor=await welcomeVisitor(scope,id,db),org=scope.organizationId;
 let state:any={version:0};
 if(tracking){
  await db.query(`INSERT IGNORE INTO intelligence_welcome_state(organization_id,visitor_id,tracked_since) VALUES(?,?,UTC_TIMESTAMP())`,[org,id]);
  const [states]:any=await db.query('SELECT * FROM intelligence_welcome_state WHERE organization_id = ? AND visitor_id = ? FOR UPDATE',[org,id]);state=states[0];
  if(requireVersion(body.expected_version)!==Number(state.version))throw new IntelligenceError(409,'A jornada foi alterada por outra pessoa. Atualize antes de salvar.');
 }
 const operation=body.operation||'stage';let next=body.stage,kind='STAGE_CHANGED',cellId=visitor.assigned_cell_id,leaderId=visitor.assigned_leader_id;
 if(visitor.stage==='ARCHIVED'&&!(operation==='stage'&&['NEW','ARCHIVED'].includes(next)))throw new IntelligenceError(400,'Retome explicitamente a jornada arquivada antes de registrar novos avanços.');
 let linkedMember=state.linked_member_id||null,attendanceAt:string|null=null,referralInfo:any={};
 if(operation==='refer'){
  if(!safeIdentifier(body.cell_group_id))throw new IntelligenceError(400,'Selecione uma célula.');
  const f=scopedWhere({...scope,campusIds:[visitor.campus_id]},'cg','campus_id','id');
  const [cells]:any=await db.query(`SELECT cg.id,cg.name,cg.leader_id,leader.name AS leader_name,leader.phone AS leader_phone FROM cell_groups cg
   LEFT JOIN members leader ON leader.organization_id = cg.organization_id AND leader.id = cg.leader_id
   WHERE cg.organization_id = ? AND cg.id = ?${f.sql} LIMIT 1`,[org,body.cell_group_id,...f.params]);
  if(!cells.length)throw new IntelligenceError(404,'Célula não encontrada na mesma unidade e escopo.');
  if(cellId!==cells[0].id&&linkedMember)throw new IntelligenceError(409,'O visitante já possui vínculo confirmado. Revise o cadastro antes de trocar a célula.');
  cellId=cells[0].id;leaderId=cells[0].leader_id;next='REFERRED_TO_CELL';kind='REFERRED';
  referralInfo={cell_name:cells[0].name,leader_name:cells[0].leader_name,leader_phone:cells[0].leader_phone,visitor_name:visitor.name,visitor_phone:visitor.phone};
 }else if(operation==='link'||(tracking&&['ATTENDING_CELL','INTEGRATED_MEMBER'].includes(next))){
  const memberId=body.member_id||linkedMember;
  if(!cellId||!safeIdentifier(memberId))throw new IntelligenceError(400,'Encaminhe para uma célula e selecione o cadastro vinculado.');
  const [members]:any=await db.query(`SELECT id FROM members WHERE organization_id = ? AND id = ? AND COALESCE(campus_id,'campus_sede') = ? AND cell_group_id = ?
   AND UPPER(status) IN ('ACTIVE','ATIVO') AND UPPER(role) NOT IN ('VISITOR','VISITANTE') LIMIT 1 FOR UPDATE`,[org,memberId,visitor.campus_id,cellId]);
  if(!members.length)throw new IntelligenceError(400,'O cadastro precisa estar ativo e vinculado à célula e unidade do visitante.');
  if(linkedMember&&linkedMember!==memberId)throw new IntelligenceError(409,'Já existe outro cadastro vinculado. Solicite revisão dos dados.');
  // One member cannot silently represent two visitor journeys in the same tenant.
  const [duplicates]:any=await db.query(`SELECT visitor_id FROM intelligence_welcome_state WHERE organization_id = ? AND linked_member_id = ? AND visitor_id <> ? LIMIT 1`,[org,memberId,id]);
  if(duplicates.length)throw new IntelligenceError(409,'Este cadastro já está vinculado a outra jornada.');
  linkedMember=memberId;kind='CELL_LINK_CONFIRMED';if(operation==='link')next=visitor.stage;
  if(operation!=='link'){
   const [present]:any=await db.query(`SELECT DATE_FORMAT(MIN(cm.meeting_date),'%Y-%m-%dT12:00:00.000Z') AS first_present
    FROM cell_meeting_attendees ca INNER JOIN cell_meetings cm ON cm.organization_id = ca.organization_id AND cm.id = ca.meeting_id
    WHERE ca.organization_id = ? AND ca.member_id = ? AND ca.status = 'PRESENT' AND cm.campus_id = ? AND cm.cell_group_id = ? AND cm.meeting_date >= ? AND cm.meeting_date <= ?`,[org,memberId,visitor.campus_id,cellId,visitor.first_visit_date,dayInSaoPaulo()]);
   if(!present[0]?.first_present)throw new IntelligenceError(400,'Registre uma presença confirmada na célula após a primeira visita antes de avançar.');
   attendanceAt=present[0].first_present;kind=next==='ATTENDING_CELL'?'ATTENDANCE_CONFIRMED':'INTEGRATION_CONFIRMED';
  }
 }else if(operation!=='stage')throw new IntelligenceError(400,'Operação de acolhimento inválida.');
 if(!VISITOR_STAGES.includes(next))throw new IntelligenceError(400,'Etapa inválida.');
 if(tracking&&next==='REFERRED_TO_CELL'&&!cellId)throw new IntelligenceError(400,'Use o encaminhamento para selecionar uma célula.');
 if(next==='CONTACTED_24H')kind='CONTACT_RECORDED';if(next==='ARCHIVED')kind='ARCHIVED';
 await db.query(`UPDATE church_visitors SET stage = ?,assigned_cell_id = ?,assigned_leader_id = ?,updated_at = UTC_TIMESTAMP() WHERE organization_id = ? AND id = ?`,[next,cellId,leaderId,org,id]);
 if(tracking){
  await db.query(`UPDATE intelligence_welcome_state SET version = version + 1,linked_member_id = ?,
   contacted_at = IF(? = 'CONTACT_RECORDED',COALESCE(contacted_at,UTC_TIMESTAMP()),contacted_at),
   referred_at = IF(? = 'REFERRED',COALESCE(referred_at,UTC_TIMESTAMP()),referred_at),
   linked_at = IF(? IS NOT NULL,COALESCE(linked_at,UTC_TIMESTAMP()),linked_at),
   attended_at = IF(? IS NOT NULL,COALESCE(attended_at,?),attended_at),
   integrated_at = IF(? = 'INTEGRATION_CONFIRMED',COALESCE(integrated_at,UTC_TIMESTAMP()),integrated_at)
   WHERE organization_id = ? AND visitor_id = ?`,[linkedMember,kind,kind,linkedMember,attendanceAt,attendanceAt,kind,org,id]);
  await db.query(`INSERT INTO intelligence_welcome_events(organization_id,id,visitor_id,campus_id,cell_group_id,actor_id,kind,previous_stage,stage,occurred_at,version)
   VALUES(?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),?)`,[org,randomUUID(),id,visitor.campus_id,cellId,scope.user.userId,kind,visitor.stage,next,Number(state.version)+1]);
 }
 await logSecurityEvent({organizationId:org,campusId:visitor.campus_id,user:scope.user,action:'WELCOME_'+kind,resource:'church_visitors',resourceId:id,
  details:{previousStage:visitor.stage,stage:next,version:tracking?Number(state.version)+1:null},event,strict:true,executor:(s,p)=>db.query(s,p)});
 await db.commit();return {id,stage:next,journey_version:tracking?Number(state.version)+1:null,message:'Jornada atualizada. Nenhuma mensagem foi enviada.',...referralInfo};
 }catch(error){await db.rollback();throw error;}finally{db.release();}
}

export async function trackNewWelcome(db:any,org:string,id:string,campus:string,actorId:string|null,firstVisit:string){
 await db.query(`INSERT INTO intelligence_welcome_state(organization_id,visitor_id,baseline_known,tracked_since) VALUES(?,?,?,UTC_TIMESTAMP())`,[org,id,firstVisit===dayInSaoPaulo()?1:0]);
 await db.query(`INSERT INTO intelligence_welcome_events(organization_id,id,visitor_id,campus_id,actor_id,kind,stage,occurred_at,version)
 VALUES(?,?,?,?,?,'REGISTERED','NEW',UTC_TIMESTAMP(),0)`,[org,randomUUID(),id,campus,actorId]);
}
