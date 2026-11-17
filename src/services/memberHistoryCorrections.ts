import {createHash} from 'crypto';
import {query,getConnection} from '../db';
import {IntelligenceScope} from './intelligenceScope';
import {safeIdentifier} from './intelligenceModel';
import {evaluateTenantFlags} from './featureFlagService';
import {IntelligenceError} from './intelligenceUsage';
import {logSecurityEvent} from './auditLogService';

const EVENT_FIELDS = `h.*,DATE_FORMAT(h.occurred_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS occurred_at,
 DATE_FORMAT(h.observed_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS observed_at`;
const uuid = (v:any) => typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const ref = (v:any) => {if(!safeIdentifier(v))throw new IntelligenceError(400,'Referência histórica inválida.');return v as string;};
export function historyInstant(value:any) {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(\d{3})?Z$/.test(value))throw new IntelligenceError(400,'Informe uma data efetiva válida com fuso.');
 const ms=Date.parse(value);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==value.slice(0,23)+'Z')throw new IntelligenceError(400,'Data efetiva inválida.');
 return value.slice(0,23)+(value.length===27?value.slice(23,26):'000')+'Z';
}
const sqlTime=(v:string)=>v.replace('T',' ').replace('Z','');
export async function memberHistoryRevision(org:string,executor?:any) {
 const sql="SELECT revision,DATE_FORMAT(revised_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS revised_at FROM member_history_revision_state WHERE organization_id = ?";
 const rows=executor?(await executor.query(sql,[org]))[0]:(await query(sql,[org])).rows;
 return {revision:Number(rows[0]?.revision||0),revised_at:rows[0]?.revised_at||null};
}
export async function historyCorrectionAccess(scope:IntelligenceScope,campus:string|null=scope.campusId) {
 if(!['SUPERADMIN','PASTOR','ADMIN'].includes(scope.user.role)||scope.campusIds!==null||scope.cellIds!==null)throw new IntelligenceError(403,'A revisão histórica exige acesso administrativo a todas as unidades.');
 const flags=(await evaluateTenantFlags(scope.organizationId,campus,'production')).flags;
 if(!['intelligence.overview','intelligence.history','intelligence.history_corrections','members.module_enabled'].every(k=>flags[k]))throw new IntelligenceError(403,'A revisão histórica não está habilitada neste acesso.');
}
async function historicalEvent(db:any,scope:IntelligenceScope,eventId:string) {
 const [rows]=await db.query(`SELECT ${EVENT_FIELDS} FROM member_state_history_effective h WHERE h.organization_id = ? AND h.id = ?`,[scope.organizationId,ref(eventId)]);
 if(!rows.length)throw new IntelligenceError(404,'Registro histórico não encontrado.');return rows[0];
}
async function eventAccess(scope:IntelligenceScope,h:any) {
 const campuses=[...(h.kind!=='BASELINE'&&h.kind!=='CREATED'?[h.before_campus_id||'campus_sede']:[]),...(h.kind!=='REMOVED'?[h.after_campus_id||'campus_sede']:[])];
 for(const campus of new Set(campuses))await historyCorrectionAccess(scope,campus);
}
export async function historyCorrectionDetails(scope:IntelligenceScope,eventId:string,page=0) {
 await historyCorrectionAccess(scope);if(!Number.isInteger(page)||page<0||page>1000)throw new IntelligenceError(400,'Página inválida.');
 const db:any=await getConnection();try {
  // All reads of a review use one consistent transaction snapshot.
  await db.beginTransaction();const h=await historicalEvent(db,scope,eventId);await eventAccess(scope,h);
  const [original]=await db.query(`SELECT h.*,DATE_FORMAT(h.occurred_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS occurred_at FROM member_state_history h WHERE h.organization_id = ? AND h.id = ?`,[scope.organizationId,h.id]);
  await eventAccess(scope,original[0]);
  const [revisions]=await db.query(`SELECT id,event_version,revision,reason,actor_id,after_status,after_campus_id,after_cell_id,
   DATE_FORMAT(effective_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS effective_at,DATE_FORMAT(recorded_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS recorded_at
   FROM member_history_corrections WHERE organization_id = ? AND history_id = ? ORDER BY event_version DESC LIMIT 51 OFFSET ?`,[scope.organizationId,h.id,page*50]);
  for(const r of revisions)if(h.kind!=='REMOVED')await historyCorrectionAccess(scope,r.after_campus_id||'campus_sede');
  const [coverage]=await db.query(`SELECT c.generation FROM member_history_coverage c INNER JOIN tenant_feature_flags f ON f.organization_id=c.organization_id AND f.id=c.flag_id
   WHERE c.organization_id = ? AND c.invalidated_at IS NULL AND c.flag_updated_at=f.updated_at AND f.is_enabled=1 AND f.feature_key='intelligence.history' AND f.environment='production' AND f.campus_id IS NULL`,[scope.organizationId]);
  const [campuses]=await db.query('SELECT id,name FROM campuses WHERE organization_id = ? ORDER BY name LIMIT 201',[scope.organizationId]);
  const [cells]=await db.query('SELECT id,name,COALESCE(campus_id,\'campus_sede\') AS campus_id FROM cell_groups WHERE organization_id = ? ORDER BY name LIMIT 501',[scope.organizationId]);
  const revision=await memberHistoryRevision(scope.organizationId,db);await db.commit();
  return {event:h,original:original[0],...revision,correction_allowed:coverage[0]?.generation===h.generation&&h.kind!=='BASELINE',revisions:revisions.slice(0,50),has_more:revisions.length>50,page,campuses:campuses.slice(0,200),campuses_truncated:campuses.length>200,cells:cells.slice(0,500),cells_truncated:cells.length>500};
 }catch(e){await db.rollback();throw e;}finally{db.release();}
}
export function correctionInput(eventId:string,body:any,actor:string) {
 ref(eventId);if(!uuid(body.request_id)||!uuid(body.generation)||!Number.isInteger(body.expected_version)||body.expected_version<0||!Number.isInteger(body.expected_revision)||body.expected_revision<0)throw new IntelligenceError(400,'Confira as referências e a versão da revisão.');
 if(typeof body.reason!=='string'||body.reason.trim().length<10||body.reason.trim().length>500||/[\x00-\x1f]/.test(body.reason))throw new IntelligenceError(400,'Informe uma justificativa entre 10 e 500 caracteres.');
 const status=body.after_status;
 if(status!==null&&(typeof status!=='string'||!['ACTIVE','ATIVO','INACTIVE','INATIVO','PENDING','PENDENTE','BLOCKED','DISABLED'].includes(status.toUpperCase())))throw new IntelligenceError(400,'Situação histórica inválida.');
 const data={eventId,generation:body.generation,expected_version:body.expected_version,expected_revision:body.expected_revision,effective_at:historyInstant(body.effective_at),
  after_status:status,after_campus_id:body.after_campus_id===null?null:ref(body.after_campus_id),after_cell_id:body.after_cell_id===null?null:ref(body.after_cell_id),reason:body.reason.trim(),actor};
 return {data,hash:createHash('sha256').update(JSON.stringify(data)).digest('hex')};
}
export async function correctMemberHistory(scope:IntelligenceScope,eventId:string,body:any,event:any) {
 await historyCorrectionAccess(scope);const {data,hash}=correctionInput(eventId,body,scope.user.userId);const db:any=await getConnection();
 try {
  await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  await db.beginTransaction();
  // Ordinary member writes acquire the member before their INSERT/SELECT trigger
  // reads coverage/flags. Follow that order, sharing those source locks. NOWAIT
  // avoids a cycle with baseline initialization, which locks the flag first.
  const [target]=await db.query('SELECT member_id FROM member_state_history WHERE organization_id = ? AND id = ?',[scope.organizationId,eventId]);
  if(!target.length)throw new IntelligenceError(404,'Registro histórico não encontrado.');
  await db.query('SELECT id FROM members WHERE organization_id = ? AND id = ? FOR UPDATE',[scope.organizationId,target[0].member_id]);
  const [flags]=await db.query("SELECT id FROM tenant_feature_flags WHERE organization_id = ? AND feature_key='intelligence.history' AND campus_id IS NULL AND environment='production' AND is_enabled=1 FOR SHARE NOWAIT",[scope.organizationId]);
  if(flags.length!==1)throw new IntelligenceError(409,'O histórico exige uma linha de base ativa.');
  const [coverage]=await db.query(`SELECT c.generation,DATE_FORMAT(c.started_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS started_at
   FROM member_history_coverage c INNER JOIN tenant_feature_flags f ON f.organization_id=c.organization_id AND f.id=c.flag_id
   WHERE c.organization_id = ? AND c.invalidated_at IS NULL AND f.updated_at=c.flag_updated_at AND f.id = ? FOR SHARE NOWAIT`,[scope.organizationId,flags[0].id]);
  const h=await historicalEvent(db,scope,eventId);await eventAccess(scope,h);
  const [retry]=await db.query('SELECT request_hash,revision,event_version FROM member_history_corrections WHERE organization_id = ? AND id = ?',[scope.organizationId,body.request_id]);
  if(retry.length){if(retry[0].request_hash!==hash)throw new IntelligenceError(409,'Solicitação já utilizada com outros dados.');await db.commit();return {recorded:false,revision:Number(retry[0].revision),event_version:Number(retry[0].event_version)};}
  if(!coverage.length||coverage[0].generation!==data.generation||h.generation!==data.generation)throw new IntelligenceError(409,'A cobertura mudou. Atualize o histórico antes de revisar.');
  if(h.kind==='BASELINE')throw new IntelligenceError(409,'A linha de base é uma observação imutável; não comprova situação anterior.');
  if(Number(h.correction_version)!==data.expected_version)throw new IntelligenceError(409,'Este registro já foi revisado. Atualize antes de salvar.');
  if(data.effective_at<coverage[0].started_at||data.effective_at>h.observed_at)throw new IntelligenceError(400,'A vigência deve estar entre o início da cobertura e a observação original.');
  const [neighbors]=await db.query(`SELECT id,kind,DATE_FORMAT(occurred_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS occurred_at,sequence_id FROM member_state_history_effective
   WHERE organization_id = ? AND generation = ? AND member_id = ? AND id <> ? ORDER BY sequence_id`,[scope.organizationId,h.generation,h.member_id,h.id]);
  const previous=neighbors.filter((n:any)=>Number(n.sequence_id)<Number(h.sequence_id)).at(-1),next=neighbors.find((n:any)=>Number(n.sequence_id)>Number(h.sequence_id));
  if(previous&&data.effective_at<=previous.occurred_at||next&&data.effective_at>=next.occurred_at)throw new IntelligenceError(409,'A data deve preservar a ordem dos fatos deste cadastro. Revise os registros vizinhos primeiro.');
  const changed=data.after_status!==h.after_status||data.after_campus_id!==h.after_campus_id||data.after_cell_id!==h.after_cell_id;
  if(h.kind==='REMOVED'&&(data.after_status!==null||data.after_campus_id!==null||data.after_cell_id!==null))throw new IntelligenceError(400,'Uma remoção não possui estado posterior.');
  if(h.kind!=='REMOVED'&&!data.after_status)throw new IntelligenceError(400,'Informe situação e unidade históricas.');
  if(h.kind!=='REMOVED'&&data.after_campus_id===null&&h.after_campus_id!==null)throw new IntelligenceError(400,'Selecione uma unidade histórica explícita; a referência legada só pode ser preservada.');
  if(changed&&!next)throw new IntelligenceError(409,'O último estado observado deve coincidir com o cadastro atual. Corrija o cadastro na origem antes de revisar o histórico.');
  if(!changed&&data.effective_at===h.occurred_at)throw new IntelligenceError(400,'Nenhuma alteração histórica informada.');
  if(data.after_campus_id){
   await historyCorrectionAccess(scope,data.after_campus_id);
   if(data.after_campus_id!==h.after_campus_id){const [campus]=await db.query('SELECT id FROM campuses WHERE organization_id = ? AND id = ?',[scope.organizationId,data.after_campus_id]);if(!campus.length)throw new IntelligenceError(400,'Unidade não encontrada nesta organização.');}
  }
  // Preserve a deleted historic cell if unchanged; a newly assigned cell must
  // exist in the same tenant and campus, with its source module enabled.
  if(data.after_cell_id&&(data.after_cell_id!==h.after_cell_id||data.after_campus_id!==h.after_campus_id)){
   const f=(await evaluateTenantFlags(scope.organizationId,data.after_campus_id,'production')).flags;if(!f['cell_groups.module_enabled'])throw new IntelligenceError(403,'Células não estão habilitadas nesta unidade.');
   const [cells]=await db.query("SELECT id FROM cell_groups WHERE organization_id = ? AND id = ? AND COALESCE(campus_id,'campus_sede') = ?",[scope.organizationId,data.after_cell_id,data.after_campus_id||'campus_sede']);if(!cells.length)throw new IntelligenceError(400,'Célula não encontrada nesta organização/unidade.');
  }
  await db.query('INSERT IGNORE INTO member_history_revision_state(organization_id,revision) VALUES(?,0)',[scope.organizationId]);
  const [revision]=await db.query('SELECT revision FROM member_history_revision_state WHERE organization_id = ? FOR UPDATE',[scope.organizationId]);
  if(Number(revision[0].revision)!==data.expected_revision)throw new IntelligenceError(409,'Os indicadores receberam outra revisão. Confira novamente o histórico.');
  const number=Number(revision[0].revision)+1,version=Number(h.correction_version)+1;
  await db.query(`INSERT INTO member_history_corrections(organization_id,id,history_id,generation,member_id,revision,event_version,effective_at,after_status,after_campus_id,after_cell_id,reason,actor_id,request_hash,recorded_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6))`,[scope.organizationId,body.request_id,h.id,h.generation,h.member_id,number,version,sqlTime(data.effective_at),data.after_status,data.after_campus_id,data.after_cell_id,data.reason,scope.user.userId,hash]);
  await db.query('UPDATE member_history_revision_state SET revision=?,revised_at=UTC_TIMESTAMP(6) WHERE organization_id = ?',[number,scope.organizationId]);
  await logSecurityEvent({organizationId:scope.organizationId,user:scope.user,action:'CORRECT_MEMBER_HISTORY',resource:'member_state_history',resourceId:h.id,
   details:{correction_id:body.request_id,revision:number,event_version:version,reason:data.reason,before:{effective_at:h.occurred_at,status:h.after_status,campus_id:h.after_campus_id,cell_id:h.after_cell_id},after:{effective_at:data.effective_at,status:data.after_status,campus_id:data.after_campus_id,cell_id:data.after_cell_id},original_preserved:true,current_member_changed:false},event,strict:true,executor:(s,p)=>db.query(s,p)});
  await db.commit();return {recorded:true,revision:number,event_version:version};
 }catch(e){await db.rollback();if(['ER_LOCK_NOWAIT','ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes((e as any).code))throw new IntelligenceError(409,'O cadastro ou sua cobertura estão em atualização. Consulte novamente antes de revisar.');throw e;}finally{db.release();}
}
