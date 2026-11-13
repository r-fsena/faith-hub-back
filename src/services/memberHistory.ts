import {query,getConnection} from '../db';
import {IntelligenceScope,scopedWhere} from './intelligenceScope';
import {intelligencePeriod,utcBoundary,safeIdentifier} from './intelligenceModel';
import {evaluateTenantFlags} from './featureFlagService';
import {IntelligenceError} from './intelligenceUsage';
import {logSecurityEvent} from './auditLogService';
const {initializeHistoryBaseline}=require('../../scripts/foundation-schema.cjs');
const UTC=(day:string)=>utcBoundary(day).slice(0,19).replace('T',' ');

export async function historyCoverage(org:string){
 const {rows}=await query(`SELECT c.generation,DATE_FORMAT(c.started_at,'%Y-%m-%dT%H:%i:%s.000Z') AS started_at,
 (c.invalidated_at IS NULL AND f.is_enabled=1 AND f.feature_key='intelligence.history' AND f.environment='production' AND f.campus_id IS NULL AND f.updated_at=c.flag_updated_at) AS ready
 FROM member_history_coverage c LEFT JOIN tenant_feature_flags f ON f.organization_id=c.organization_id AND f.id=c.flag_id WHERE c.organization_id = ?`,[org]);
 return{generation:rows[0]?.generation||null,started_at:rows[0]?.started_at||null,ready:!!Number(rows[0]?.ready||0)};
}
export async function initializeMemberHistory(scope:IntelligenceScope,event:any){
 if(!['SUPERADMIN','PASTOR','ADMIN'].includes(scope.user.role)||scope.campusIds!==null)throw new IntelligenceError(403,'A linha de base exige acesso administrativo a todas as unidades.');
 const db=await getConnection();try{await db.beginTransaction();const generation=await initializeHistoryBaseline(db,scope.organizationId,scope.user.userId);
 await logSecurityEvent({organizationId:scope.organizationId,user:scope.user,action:'INITIALIZE_MEMBER_HISTORY',resource:'member_history_coverage',resourceId:scope.organizationId,
 details:{generation,pastInferred:false},event,strict:true,executor:(s,p)=>db.query(s,p)});await db.commit();return{generation,initialized:true};
 }catch(e){await db.rollback();throw e;}finally{db.release();}
}
export async function memberHistory(scope:IntelligenceScope,preset:string,options:any={}){
 if(!['SUPERADMIN','PASTOR','ADMIN','LEADER'].includes(scope.user.role))throw new IntelligenceError(403,'Sem acesso ao histórico de membros.');
 const period=intelligencePeriod(preset),coverage=await historyCoverage(scope.organizationId),page=Number(options.page||0);
 if(!Number.isInteger(page)||page<0||page>100)throw new IntelligenceError(400,'Página inválida.');
 if(options.member_id&&!safeIdentifier(options.member_id))throw new IntelligenceError(400,'Cadastro inválido.');
 const cf=scopedWhere({...scope,cellIds:null},'c','id');
 const {rows:campuses}=await query(`SELECT c.id,c.name FROM campuses c WHERE c.organization_id = ?${cf.sql} ORDER BY c.id LIMIT 201`,[scope.organizationId,...cf.params]);
 if(campuses.length>200)throw new IntelligenceError(400,'Selecione uma unidade.');
 const allowed:any[]=[];for(const c of campuses){const evaluated=await evaluateTenantFlags(scope.organizationId,c.id,'production');if(evaluated.flags['intelligence.history']&&evaluated.flags['members.module_enabled'])allowed.push(c);}
 const restricted={...scope,campusIds:allowed.map(c=>c.id)},before=scopedWhere(restricted,'h','before_campus_id','before_cell_id'),after=scopedWhere(restricted,'h','after_campus_id','after_cell_id');
 const scopeSql=` AND ((h.kind IN ('CHANGED','REMOVED') AND 1=1${before.sql}) OR (h.kind <> 'REMOVED' AND 1=1${after.sql}))`,scopeParams=[...before.params,...after.params];
 let extra='';const params:any[]=[scope.organizationId,...scopeParams];if(options.member_id){extra+=' AND h.member_id = ?';params.push(options.member_id);}
 const {rows}=await query(`SELECT h.id,h.member_id,h.kind,h.before_status,h.after_status,h.before_role,h.after_role,h.before_campus_id,h.after_campus_id,h.before_cell_id,h.after_cell_id,h.actor_id,h.source,
 DATE_FORMAT(h.occurred_at,'%Y-%m-%dT%H:%i:%s.000Z') AS occurred_at,h.generation
 FROM member_state_history h WHERE h.organization_id = ?${scopeSql}${extra} ORDER BY h.sequence_id DESC LIMIT 101 OFFSET ?`,[...params,page*100]);
 const canRead=(campus:any,cell:any)=>allowed.some(c=>c.id===(campus||'campus_sede'))&&(scope.cellIds===null||scope.cellIds.includes(cell));
 const side=(r:any,prefix:string)=>((prefix==='before'&&['BASELINE','CREATED'].includes(r.kind))||(prefix==='after'&&r.kind==='REMOVED'))?{absent:true}:canRead(r[prefix+'_campus_id'],r[prefix+'_cell_id'])?{status:r[prefix+'_status'],role:r[prefix+'_role'],campus_id:r[prefix+'_campus_id'],cell_id:r[prefix+'_cell_id'],restricted:false}:{restricted:true};
 const events=rows.slice(0,100).map(r=>({id:r.id,member_id:r.kind!=='REMOVED'&&canRead(r.after_campus_id,r.after_cell_id)?r.member_id:null,kind:r.kind,before:side(r,'before'),after:side(r,'after'),
 source:r.source,actor_recorded:!!r.actor_id,occurred_at:r.occurred_at,current_generation:r.generation===coverage.generation}));
 const {rows:counts}=await query(`SELECT COUNT(*) AS records,SUM(h.kind='CREATED') AS created_records,SUM(h.kind='REMOVED') AS removed_records,
 SUM(h.kind='CHANGED' AND NOT(h.before_status <=> h.after_status)) AS status_changes,
 SUM(h.kind='CHANGED' AND NOT(h.before_campus_id <=> h.after_campus_id)) AS campus_changes,
 SUM(h.kind='CHANGED' AND NOT(h.before_cell_id <=> h.after_cell_id)) AS cell_changes
 FROM member_state_history h WHERE h.organization_id = ? AND h.kind <> 'BASELINE' AND h.occurred_at >= ? AND h.occurred_at < ?${scopeSql}`,[scope.organizationId,UTC(period.start),UTC(period.end),...scopeParams]);
 const snapshot=async(day:string)=>{
  if(!coverage.ready||!coverage.started_at||UTC(day)<String(coverage.started_at).slice(0,19).replace('T',' '))return null;
  const f=scopedWhere(restricted,'h','after_campus_id','after_cell_id');
  const {rows:states}=await query(`WITH latest AS (SELECT member_id,MAX(sequence_id) AS sequence_id FROM member_state_history
   WHERE organization_id = ? AND generation = ? AND occurred_at < ? GROUP BY member_id)
   SELECT COUNT(*) AS active FROM member_state_history h INNER JOIN latest l ON l.sequence_id=h.sequence_id AND l.member_id=h.member_id
   WHERE h.organization_id = ? AND h.kind <> 'REMOVED' AND UPPER(h.after_status) IN ('ACTIVE','ATIVO') AND UPPER(h.after_role) NOT IN ('VISITOR','VISITANTE')${f.sql}`,[scope.organizationId,coverage.generation,UTC(day),scope.organizationId,...f.params]);return Number(states[0]?.active||0);
 };
 return{period,coverage,events,page,has_more:rows.length>100,counts:Object.fromEntries(Object.entries(counts[0]||{}).map(([k,v])=>[k,Number(v||0)])),
  snapshots:{current:await snapshot(period.end),previous:await snapshot(period.previousEnd)},manage_allowed:['SUPERADMIN','PASTOR','ADMIN'].includes(scope.user.role)&&scope.campusIds===null,
  campuses:allowed,definitions:['Eventos são alterações observadas no sistema, não datas de chegada à igreja. A linha de base não inventa passado.',
   'Os contadores usam os dias completos do período. A lista mostra as alterações mais recentes, incluindo hoje.',
   'Mudança ou pausa da configuração exige nova linha de base. Os registros anteriores são preservados; comparações sem cobertura ficam indisponíveis.',
   'A captura é transacional em todos os caminhos de gravação. Ator/origem são informados quando o fluxo os fornece; DATABASE não comprova autoria de uma pessoa.',
   'O acesso usa as unidades/grupos atuais do leitor. O lado fora do escopo permanece oculto.']};
}
