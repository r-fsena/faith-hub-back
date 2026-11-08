import {query} from '../db';
import {IntelligenceScope,scopedWhere} from './intelligenceScope';
import {intelligencePeriod,utcBoundary,INTELLIGENCE_VERSION,dayInSaoPaulo,CONTENT_FLAGS} from './intelligenceModel';
import {IntelligenceError} from './intelligenceUsage';

const protectedCount=(value:any)=>{const n=Number(value||0);return n>0&&n<10?null:n;};
async function lastPolicyChange(scope:IntelligenceScope,key:string){
 const campus=scope.campusIds?` AND (campus_id IS NULL OR campus_id IN (${scope.campusIds.map(()=>'?').join(',')||"''"}))`:'';
 const {rows}=await query(`SELECT DATE_FORMAT(MAX(updated_at),'%Y-%m-%dT%H:%i:%s.000Z') AS last_changed FROM tenant_feature_flags
 WHERE (organization_id = ? OR organization_id = 'global') AND feature_key = ? AND environment IN ('all','production')${campus}`,[scope.organizationId,key,...(scope.campusIds||[])]);
 return rows[0]?.last_changed||null;
}
function digitalCohort(row:any){
 const counts=['authorized','measured_access','qualified_use','mature_return','returned'];
 const small=(n:number)=>n>0&&n<10;
 // Suppress the digital block together when its success/complement or adjacent
 // stages could reveal a small group by subtraction from the operational base.
 const values=counts.map(key=>Number(row[key]||0));
 const unsafe=Number(row.authorized)<10||values.some(value=>small(value)||small(Number(row.invited)-value))||
 values.some((value,index)=>values.slice(index+1).some(other=>small(Math.abs(value-other))));
 return Object.fromEntries(counts.map(key=>[key,unsafe?null:protectedCount(row[key])]));
}
export async function activationFunnel(scope:IntelligenceScope,flags:Record<string,boolean>,preset:string){
 const period=intelligencePeriod(preset),org=scope.organizationId;
 const offset=(Date.parse(utcBoundary(period.start))-Date.parse(period.start+'T00:00:00Z'))/60000;
 if(offset!==(Date.parse(utcBoundary(period.end))-Date.parse(period.end+'T00:00:00Z'))/60000)throw new IntelligenceError(400,'A janela cruza uma alteração de fuso; selecione outro período.');
 const member=scopedWhere(scope,'m','campus_id','cell_group_id'),invitation=scopedWhere({...scope,cellIds:null},'e');
 const activity=scopedWhere(scope,'a','campus_id','cell_group_id'),content=scopedWhere({...scope,cellIds:null},'e'),returnScope=scopedWhere(scope,'r','campus_id','cell_group_id');
 const contentTypes=Object.keys(CONTENT_FLAGS).filter(type=>flags[CONTENT_FLAGS[type]]);
 const policyChange=await lastPolicyChange(scope,'intelligence.usage_collection');
 const policyStamp=policyChange?policyChange.slice(0,19).replace('T',' '):null;
 const start=utcBoundary(period.start).slice(0,19).replace('T',' '),end=utcBoundary(period.end).slice(0,19).replace('T',' ');
 const {rows:operations}=await query(`SELECT COUNT(DISTINCT CASE WHEN e.outcome = 'REGISTERED' THEN e.user_id END) AS registered,
 COUNT(DISTINCT CASE WHEN e.outcome = 'REQUESTED' THEN e.user_id END) AS invitation_requested,
 SUM(e.outcome = 'REQUESTED') AS requests,SUM(e.outcome = 'FAILED') AS failed_requests,
 DATE_FORMAT(MIN(e.occurred_at),'%Y-%m-%dT%H:%i:%s.000Z') AS first_record
 FROM intelligence_invitation_events e INNER JOIN members m ON m.organization_id = e.organization_id AND m.id = e.user_id
 WHERE e.organization_id = ? AND e.occurred_at >= ? AND e.occurred_at < ?${invitation.sql}${member.sql}`,[org,start,end,...invitation.params,...member.params]);
 const {rows}=await query(`WITH invited AS (
  SELECT e.user_id,MIN(e.occurred_at) AS invited_at FROM intelligence_invitation_events e
  WHERE e.organization_id = ? AND e.outcome = 'REQUESTED'${invitation.sql} GROUP BY e.user_id
 ), started AS (
  SELECT a.subject_key,MIN(a.first_at) AS first_at,MIN(a.activity_date) AS first_day,
  ((? IS NULL OR MIN(a.first_at) >= ?) AND ? = 1) AS comparable
  FROM intelligence_activity_daily a WHERE a.organization_id = ? AND a.actor_kind = 'member'${activity.sql} GROUP BY a.subject_key
 ), qualified AS (
  SELECT e.user_id,MIN(e.occurred_at) AS first_qualified FROM content_engagement_events e
  WHERE e.organization_id = ? AND e.source = 'PWA_INTELLIGENCE_V1' AND e.event_type IN ('STARTED','COMPLETED','STREAM_STARTED','CTA_CLICKED')
  AND e.content_type IN (${contentTypes.map(()=>'?').join(',')||"''"})${content.sql} GROUP BY e.user_id
 )
 SELECT DATE_FORMAT(TIMESTAMPADD(MINUTE,?,i.invited_at),'%Y-%m') AS cohort,COUNT(*) AS invited,
 SUM(c.allowed = 1 AND c.policy_version = ? AND m.birth_date <= DATE_SUB(?,INTERVAL 18 YEAR)) AS authorized,
 SUM(c.allowed = 1 AND c.policy_version = ? AND s.first_at >= i.invited_at AND s.first_at < ?) AS measured_access,
 SUM(c.allowed = 1 AND c.policy_version = ? AND s.first_at >= i.invited_at AND q.first_qualified >= i.invited_at AND q.first_qualified < ?) AS qualified_use,
 SUM(c.allowed = 1 AND c.policy_version = ? AND s.comparable = 1 AND s.first_at >= i.invited_at AND DATE_ADD(s.first_at,INTERVAL 7 DAY) <= ?) AS mature_return,
 SUM(c.allowed = 1 AND c.policy_version = ? AND s.comparable = 1 AND s.first_at >= i.invited_at AND DATE_ADD(s.first_at,INTERVAL 7 DAY) <= ?
  AND EXISTS(SELECT 1 FROM intelligence_activity_daily r WHERE r.organization_id = ? AND r.subject_key = s.subject_key
  AND r.actor_kind = 'member' AND r.activity_date > s.first_day AND r.first_at < DATE_ADD(s.first_at,INTERVAL 7 DAY)${returnScope.sql})) AS returned
 FROM invited i INNER JOIN members m ON m.organization_id = ? AND m.id = i.user_id
 LEFT JOIN intelligence_consent c ON c.organization_id = m.organization_id AND c.user_id = m.id
 LEFT JOIN started s ON s.subject_key = SHA2(CONCAT(m.organization_id,':',m.id,':usage-v1'),256)
 LEFT JOIN qualified q ON q.user_id = m.id
 WHERE i.invited_at >= ? AND i.invited_at < ? AND UPPER(m.role) IN ('MEMBER','MEMBRO','VOLUNTEER','VOLUNTARIO')
 AND YEAR(m.birth_date) > 0 AND m.birth_date <= DATE_SUB(?,INTERVAL 18 YEAR)${member.sql} GROUP BY cohort ORDER BY cohort`,[
 org,...invitation.params,policyStamp,policyStamp,flags['intelligence.usage_collection']?1:0,org,...activity.params,org,...contentTypes,...content.params,-offset,INTELLIGENCE_VERSION,dayInSaoPaulo(),INTELLIGENCE_VERSION,end,INTELLIGENCE_VERSION,end,
 INTELLIGENCE_VERSION,end,INTELLIGENCE_VERSION,end,org,...returnScope.params,org,start,end,dayInSaoPaulo(),...member.params]);
 const {rows:coverage}=await query(`SELECT DATE_FORMAT(MIN(e.occurred_at),'%Y-%m-%dT%H:%i:%s.000Z') AS started_at
 FROM intelligence_invitation_events e INNER JOIN members m ON m.organization_id = e.organization_id AND m.id = e.user_id
 WHERE e.organization_id = ?${invitation.sql}${member.sql}`,[org,...invitation.params,...member.params]);
 return {period,operations:{registered:Number(operations[0]?.registered||0),invitation_requested:Number(operations[0]?.invitation_requested||0),requests:Number(operations[0]?.requests||0),failed_requests:Number(operations[0]?.failed_requests||0)},
  cohorts:rows.map(row=>{const digital=digitalCohort(row);return {cohort:row.cohort,invited:Number(row.invited),...digital,return_percent:digital.mature_return!==null&&digital.returned!==null&&Number(row.mature_return)>=10?Math.round(Number(row.returned)/Number(row.mature_return)*1000)/10:null};}),
  coverage:{started_at:coverage[0]?.started_at||null,collection_enabled:!!flags['intelligence.usage_collection'],last_collection_change:policyChange,minimum_sample:10,return_window_days:7},
  definitions:[
   'Convite solicitado significa que o provedor aceitou a solicitação. Não confirma entrega, leitura ou definição de senha.',
   'Primeiro acesso medido é a primeira interação recebida após a autorização, no histórico retido. Não é o primeiro login absoluto.',
   'Primeiro uso qualificado exige uma interação válida de início, conclusão, transmissão ou chamada para ação de conteúdo; abrir uma tela não basta.',
   'Retorno em 7 dias exige uso em outro dia e uma janela de sete dias encerrada após o primeiro uso medido. Equipe administrativa não entra nessa amostra.',
   'A taxa representa retorno observado, não ausência comprovada de uso. Mudança recente de configuração ou coleta pausada impede considerar a janela de retorno comparável.',
   'A amostra digital contém somente adultos que autorizaram e ainda mantêm a autorização. Ela não representa todas as pessoas convidadas; retirada da autorização e retenção de 90 dias podem revisar os números.',
   'O bloco digital também é protegido quando diferenças entre etapas ou complementos permitiriam deduzir uma contagem pequena.',
   'Convites e agrupamentos usam os registros retidos e o vínculo atual dos membros. Histórico anterior à instrumentação não é presumido.'
  ]};
}

export async function communityJourney(scope:IntelligenceScope,preset:string,windowDays=7,flags:Record<string,boolean>={}){
 if(![7,14,30].includes(windowDays))throw new IntelligenceError(400,'Use uma janela de 7, 14 ou 30 dias.');
 const period=intelligencePeriod(preset),filter=scopedWhere(scope,'v','campus_id','assigned_cell_id'),org=scope.organizationId,today=dayInSaoPaulo();
 const policyChange=await lastPolicyChange(scope,'intelligence.member_journey'),policyDay=policyChange?dayInSaoPaulo(new Date(policyChange)):null;
 const offset=(Date.parse(utcBoundary(period.start))-Date.parse(period.start+'T00:00:00Z'))/60000;
 if(offset!==(Date.parse(utcBoundary(period.end))-Date.parse(period.end+'T00:00:00Z'))/60000)throw new IntelligenceError(400,'A janela cruza uma alteração de fuso; selecione outro período.');
 const {rows:cohorts}=await query(`WITH population AS (
 SELECT v.id,DATE_FORMAT(v.first_visit_date,'%Y-%m') AS cohort,
 CASE WHEN w.baseline_known = 1 AND (? IS NULL OR v.first_visit_date > ?) THEN 1 ELSE 0 END AS baseline_known,
 w.contacted_at,w.linked_at,w.attended_at,w.integrated_at,
 TIMESTAMPADD(MINUTE,?,CAST(v.first_visit_date AS DATETIME)) AS start_at,
 TIMESTAMPADD(MINUTE,?,CAST(DATE_ADD(v.first_visit_date,INTERVAL ? DAY) AS DATETIME)) AS window_end
 FROM church_visitors v LEFT JOIN intelligence_welcome_state w ON w.organization_id = v.organization_id AND w.visitor_id = v.id
 WHERE v.organization_id = ? AND v.first_visit_date >= ? AND v.first_visit_date < ?${filter.sql}
 ) SELECT cohort,COUNT(*) AS registered,SUM(COALESCE(baseline_known,0) = 0) AS unknown_history,
 SUM(baseline_known = 1 AND window_end <= ?) AS mature,
 SUM(baseline_known = 1 AND window_end <= ? AND contacted_at >= start_at AND contacted_at < window_end) AS contacted,
 SUM(baseline_known = 1 AND window_end <= ? AND linked_at >= start_at AND linked_at < window_end) AS linked,
 SUM(baseline_known = 1 AND window_end <= ? AND attended_at >= start_at AND attended_at < window_end) AS attended,
 SUM(baseline_known = 1 AND window_end <= ? AND integrated_at >= start_at AND integrated_at < window_end) AS integrated
 FROM population GROUP BY cohort ORDER BY cohort`,[policyDay,policyDay,offset,offset,windowDays,org,period.start,period.end,...filter.params,...Array(5).fill(utcBoundary(today).slice(0,19).replace('T',' '))]);
 const {rows:waiting}=await query(`SELECT v.id,v.name,v.campus_id,v.assigned_cell_id,v.first_visit_date,COALESCE(w.version,0) AS journey_version
 FROM church_visitors v LEFT JOIN intelligence_welcome_state w ON w.organization_id = v.organization_id AND w.visitor_id = v.id
 WHERE v.organization_id = ? AND v.stage = 'NEW' AND w.contacted_at IS NULL AND v.first_visit_date <= DATE_SUB(?,INTERVAL ? DAY)${filter.sql}
 AND (? = 0 OR NOT EXISTS(SELECT 1 FROM intelligence_actions a WHERE a.organization_id = v.organization_id AND a.subject_type = 'visitor' AND a.subject_id = v.id
 AND (a.closed_at IS NULL OR a.closed_at >= ?)))
 ORDER BY v.first_visit_date,v.id LIMIT 20`,[org,today,windowDays,...filter.params,flags['intelligence.actions']?1:0,utcBoundary(today.slice(0,7)+'-01').slice(0,19).replace('T',' ')]);
 const meeting=scopedWhere(scope,'cm','campus_id','cell_group_id'),cells=scopedWhere(scope,'cg','campus_id','id');
 const {rows:participation}=flags['cell_groups.module_enabled']?await query(`SELECT DATE_FORMAT(cm.meeting_date,'%x-W%v') AS week,COUNT(DISTINCT cm.id) AS meetings,
 COUNT(DISTINCT cm.cell_group_id) AS groups_recorded,COUNT(DISTINCT CASE WHEN ca.status = 'PRESENT' THEN ca.member_id END) AS participants
 FROM cell_meetings cm LEFT JOIN cell_meeting_attendees ca ON ca.organization_id = cm.organization_id AND ca.meeting_id = cm.id
 WHERE cm.organization_id = ? AND cm.meeting_date >= ? AND cm.meeting_date < ?${meeting.sql}
 GROUP BY DATE_FORMAT(cm.meeting_date,'%x-W%v') ORDER BY week`,[org,period.start,period.end,...meeting.params]):{rows:[]};
 const {rows:groups}=flags['cell_groups.module_enabled']?await query(`SELECT COUNT(*) AS total FROM cell_groups cg WHERE cg.organization_id = ?${cells.sql}`,[org,...cells.params]):{rows:[]};
 return {period,window_days:windowDays,policy_changed_at:policyChange,cohorts:cohorts.map(row=>({cohort:row.cohort,registered:Number(row.registered),unknown_history:Number(row.unknown_history||0),mature:Number(row.mature||0),
  contacted:Number(row.contacted||0),linked:Number(row.linked||0),attended:Number(row.attended||0),integrated:Number(row.integrated||0),contact_percent:Number(row.mature)>0?Math.round(Number(row.contacted||0)/Number(row.mature)*1000)/10:null})),waiting,
  participation:participation.map(row=>({week:row.week,meetings:Number(row.meetings),groups_recorded:Number(row.groups_recorded),participants:Number(row.participants)})),groups_in_current_register:Number(groups[0]?.total||0),
  definitions:[
   'Coortes agrupam a primeira visita informada. Somente jornadas acompanhadas desde o cadastro da visita no mesmo dia e com janela encerrada entram nas taxas.',
   'Registros anteriores, importados com data passada ou sem marcos completos aparecem como histórico desconhecido, sem inventar contato ou integração.',
   'Após uma alteração da configuração de jornada, somente visitas de dias posteriores entram em janelas completas; isso evita taxas artificiais quando o acompanhamento foi pausado.',
   'Contato registrado não comprova envio ou recebimento de mensagem. Encaminhamento não comprova vínculo; vínculo requer cadastro ativo na célula e unidade.',
   'Avanço para presença ou integração exige presença confirmada na célula desde a primeira visita. A integração continua sendo uma confirmação operacional do responsável.',
   'Participação considera lançamentos. Grupos com lançamento / grupos no cadastro atual informa cobertura observada; não é frequência sobre um calendário completo nem taxa de ausência.',
   'O resultado observado após uma ação não comprova causalidade. Os escopos seguem as unidades e os grupos atualmente permitidos.'
  ]};
}
