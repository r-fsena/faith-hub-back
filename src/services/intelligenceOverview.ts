import { query } from '../db';
import { intelligencePeriod, INTELLIGENCE_VERSION, utcBoundary, variation, dayInSaoPaulo } from './intelligenceModel';
import { IntelligenceScope, scopedWhere } from './intelligenceScope';

export async function intelligenceOverview(scope: IntelligenceScope, flags: Record<string,boolean>, preset: string) {
  const period = intelligencePeriod(preset);
  const org = scope.organizationId;
  const memberScope = scopedWhere(scope,'m','campus_id','cell_group_id');
  const meetingScope = scopedWhere(scope,'cm','campus_id','cell_group_id');
  const visitorScope = scopedWhere(scope,'v','campus_id','assigned_cell_id');
  const activityScope = scopedWhere(scope,'a','campus_id','cell_group_id');
  const contentScope = scopedWhere(scope,'e');
  const campusScope = scopedWhere({...scope,cellIds:null},'im');
  const range = [period.start,period.end,period.previousStart,period.previousEnd];
  const utcRange = range.map(utcBoundary).map(x=>x.slice(0,19).replace('T',' '));
  const cards:any[] = [], errors:string[] = [];
  async function metric(key:string,title:string,definition:string,tab:string,enabled:boolean,load:()=>Promise<any>) {
    if (!enabled) {cards.push({key,title,definition,tab:null,status:'not_available',value:null,previous:null,change:variation(null,null)});return;}
    try {cards.push({key,title,definition,tab,status:'available',...(await load())});}
    catch {errors.push(key);cards.push({key,title,definition,tab,status:'error',value:null,previous:null,change:variation(null,null)});}
  }
  const comparison = (row:any) => {
    const value=Number(row?.current_value||0), previous=Number(row?.previous_value||0);
    return {value,previous,change:variation(value,previous),reference:'selected_period',coverage:'registered_records'};
  };
  await metric('registered_members','Base cadastral ativa','Pessoas únicas com cadastro ativo hoje. Não representa presença nem uso do aplicativo.','membros',flags['members.module_enabled']!==false,async()=>{
    const {rows}=await query(`SELECT COUNT(DISTINCT m.id) AS total FROM members m WHERE m.organization_id = ? AND UPPER(m.status) IN ('ACTIVE','ATIVO') AND UPPER(m.role) NOT IN ('VISITOR','VISITANTE')${memberScope.sql}`,[org,...memberScope.params]);
    return {value:Number(rows[0]?.total||0),previous:null,change:variation(null,null),reference:'current_state',coverage:'current_register'};
  });
  await metric('participants','Participantes registrados','Pessoas únicas com presença confirmada em encontros no período. Registro ausente não é falta.','celulas',!!flags['cell_groups.module_enabled'],async()=>{
    const {rows}=await query(`SELECT COUNT(DISTINCT CASE WHEN cm.meeting_date >= ? AND cm.meeting_date < ? THEN ca.member_id END) AS current_value,
      COUNT(DISTINCT CASE WHEN cm.meeting_date >= ? AND cm.meeting_date < ? THEN ca.member_id END) AS previous_value
      FROM cell_meeting_attendees ca INNER JOIN cell_meetings cm ON cm.id = ca.meeting_id AND cm.organization_id = ca.organization_id
      WHERE ca.organization_id = ? AND ca.status = 'PRESENT' AND cm.meeting_date >= ? AND cm.meeting_date < ?${meetingScope.sql}`,[...range,org,period.previousStart,period.end,...meetingScope.params]);
    return comparison(rows[0]);
  });
  let waitingVisitors:number|null=null;
  await metric('new_visitors','Visitantes no período','Pessoas com primeira visita informada no período. Dados importados seguem as datas registradas, sem inferir integração.','visitantes',!!flags['visitors.module_enabled'],async()=>{
    const {rows}=await query(`SELECT COUNT(DISTINCT CASE WHEN v.first_visit_date >= ? AND v.first_visit_date < ? THEN v.id END) AS current_value,
      COUNT(DISTINCT CASE WHEN v.first_visit_date >= ? AND v.first_visit_date < ? THEN v.id END) AS previous_value,
      SUM(v.stage = 'NEW') AS waiting FROM church_visitors v WHERE v.organization_id = ?${visitorScope.sql}`,[...range,org,...visitorScope.params]);
    waitingVisitors=Number(rows[0]?.waiting||0);
    return comparison(rows[0]);
  });
  const {rows:measurement} = scope.cellIds === null
    ? await query(`SELECT DATE_FORMAT(MIN(im.started_at),'%Y-%m-%dT%H:%i:%s.000Z') AS started_at,DATE_FORMAT(MAX(im.last_event_at),'%Y-%m-%dT%H:%i:%s.000Z') AS last_event_at,DATE_FORMAT(MAX(im.last_processed_at),'%Y-%m-%dT%H:%i:%s.000Z') AS last_processed_at
      FROM intelligence_measurement im WHERE im.organization_id = ?${campusScope.sql}`,[org,...campusScope.params])
    : await query(`SELECT DATE_FORMAT(MIN(a.first_at),'%Y-%m-%dT%H:%i:%s.000Z') AS started_at,DATE_FORMAT(MAX(a.last_at),'%Y-%m-%dT%H:%i:%s.000Z') AS last_event_at,NULL AS last_processed_at
      FROM intelligence_activity_daily a WHERE a.organization_id = ?${activityScope.sql}`,[org,...activityScope.params]);
  const measured = measurement[0] || {};
  const startedAt = measured.started_at ? new Date(measured.started_at).toISOString() : null;
  const digital:any={};
  await metric('digital_active','Pessoas ativas no PWA','Pessoas adultas que autorizaram a medição e tiveram uso registrado. Equipe administrativa é contabilizada separadamente.','intelligence',true,async()=>{
    const {rows}=await query(`SELECT COUNT(DISTINCT CASE WHEN a.activity_date >= ? AND a.activity_date < ? THEN a.subject_key END) AS current_value,
      COUNT(DISTINCT CASE WHEN a.activity_date >= ? AND a.activity_date < ? THEN a.subject_key END) AS previous_value
      FROM intelligence_activity_daily a WHERE a.organization_id = ? AND a.actor_kind = 'member'
      AND a.activity_date >= ? AND a.activity_date < ?${activityScope.sql}`,[...range,org,period.previousStart,period.end,...activityScope.params]);
    const rawCurrent=Number(rows[0]?.current_value||0),rawPrevious=Number(rows[0]?.previous_value||0);
    const value=rawCurrent>0&&rawCurrent<10?null:rawCurrent;
    const previous=rawPrevious>0&&rawPrevious<10?null:rawPrevious;
    const windowMeasured = !!startedAt && startedAt < utcBoundary(period.end);
    const baselineCovered = !!startedAt && startedAt <= utcBoundary(period.previousStart);
    digital.currentSuppressed=value===null;digital.hasActivity=rawCurrent>0;
    return {value:windowMeasured?value:null,previous:baselineCovered?previous:null,change:variation(windowMeasured?value:null,baselineCovered?previous:null),
      status:!windowMeasured?'not_measured':value===null?'insufficient_sample':'available',reference:'selected_period',
      coverage:!windowMeasured?'not_started':startedAt!>utcBoundary(period.start)?'partial':'authorized_sample',
      sample_suppressed:value===null,minimum_sample:10};
  });
  await metric('content_reach','Alcance de conteúdo','Usuários ou navegadores distintos nos registros de eventos, transmissões, devocionais e estudos. Não equivale ao número de membros.','content_workspace',!!flags['content.analytics_dashboard']&&scope.cellIds===null,async()=>{
    const {rows:coverage}=await query(`SELECT DATE_FORMAT(MIN(e.occurred_at),'%Y-%m-%dT%H:%i:%s.000Z') AS first_event FROM content_engagement_events e WHERE e.organization_id = ?${contentScope.sql}${flags['events.module_enabled']?'':" AND e.content_type <> 'EVENT'"}`,[org,...contentScope.params]);
    const {rows}=await query(`SELECT COUNT(DISTINCT CASE WHEN e.occurred_at >= ? AND e.occurred_at < ? THEN COALESCE(e.user_id,e.session_hash) END) AS current_value,
      COUNT(DISTINCT CASE WHEN e.occurred_at >= ? AND e.occurred_at < ? THEN COALESCE(e.user_id,e.session_hash) END) AS previous_value
      FROM content_engagement_events e WHERE e.organization_id = ? AND e.occurred_at >= ? AND e.occurred_at < ?${contentScope.sql}${flags['events.module_enabled']?'':" AND e.content_type <> 'EVENT'"}`,[...utcRange,org,utcRange[2],utcRange[1],...contentScope.params]);
    const data=comparison(rows[0]);
    const first = coverage[0]?.first_event ? new Date(coverage[0].first_event).toISOString() : null;
    if (!first || first >= utcBoundary(period.end)) return {value:null,previous:null,change:variation(null,null),status:'not_measured',coverage:'not_started'};
    const smallCurrent=data.value>0&&data.value<10,smallPrevious=data.previous>0&&data.previous<10;
    const previous = first > utcBoundary(period.previousStart)||smallPrevious?null:data.previous;
    return {...data,value:smallCurrent?null:data.value,previous,
      change:variation(smallCurrent?null:data.value,previous),status:smallCurrent?'insufficient_sample':'available',coverage:'legacy_and_authorized_events',sample_suppressed:smallCurrent};
  });
  await metric('meetings','Encontros registrados','Encontros informados na plataforma. Sem calendário completo, este indicador não calcula taxa de cobertura ou ausência.','celulas',!!flags['cell_groups.module_enabled'],async()=>{
    const {rows}=await query(`SELECT COUNT(DISTINCT CASE WHEN cm.meeting_date >= ? AND cm.meeting_date < ? THEN cm.id END) AS current_value,
      COUNT(DISTINCT CASE WHEN cm.meeting_date >= ? AND cm.meeting_date < ? THEN cm.id END) AS previous_value
      FROM cell_meetings cm WHERE cm.organization_id = ? AND cm.meeting_date >= ? AND cm.meeting_date < ?${meetingScope.sql}`,[...range,org,period.previousStart,period.end,...meetingScope.params]);
    return comparison(rows[0]);
  });
  const usageVisible = !!startedAt && !digital.currentSuppressed && digital.hasActivity;
  const {rows:modules} = await query(`SELECT a.module,COUNT(DISTINCT a.subject_key) AS people,SUM(a.interactions) AS interactions,
      COUNT(DISTINCT a.session_key) AS sessions FROM intelligence_activity_daily a
      WHERE a.organization_id = ? AND a.actor_kind = 'member' AND a.activity_date >= ? AND a.activity_date < ?${activityScope.sql}
      GROUP BY a.module ORDER BY people DESC,a.module`,[org,period.start,period.end,...activityScope.params]);
  const {rows:daily} = await query(`SELECT DATE_FORMAT(a.activity_date,'%Y-%m-%d') AS day,COUNT(DISTINCT a.subject_key) AS people
      FROM intelligence_activity_daily a WHERE a.organization_id = ? AND a.actor_kind = 'member'
      AND a.activity_date >= ? AND a.activity_date < ?${activityScope.sql} GROUP BY a.activity_date ORDER BY a.activity_date`,[org,period.start,period.end,...activityScope.params]);
  const eligibleFilter=scopedWhere(scope,'m','campus_id','cell_group_id');
  const cutoff=`${Number(dayInSaoPaulo().slice(0,4))-18}${dayInSaoPaulo().slice(4)}`;
  const {rows:consentCounts}=await query(`SELECT COUNT(*) AS eligible,SUM(c.allowed = 1 AND c.policy_version = ?) AS authorized
    FROM members m LEFT JOIN intelligence_consent c ON c.organization_id = m.organization_id AND c.user_id = m.id
    WHERE m.organization_id = ? AND UPPER(m.status) IN ('ACTIVE','ATIVO') AND UPPER(m.role) IN ('MEMBER','MEMBRO','VOLUNTEER','VOLUNTARIO')
    AND m.birth_date >= '1900-01-01' AND m.birth_date <= ?${eligibleFilter.sql}`,[INTELLIGENCE_VERSION,org,cutoff,...eligibleFilter.params]);
  const insights:any[]=[];
  if(waitingVisitors && flags['visitors.module_enabled']) insights.push({key:'visitors_waiting',title:'Revise a fila de acolhimento',description:`Há ${waitingVisitors} visitante(s) na etapa inicial no escopo autorizado. Confira se o contato foi registrado.`,tab:'visitantes',action:'Abrir acolhimento'});
  if(!startedAt) insights.push({key:'measurement_start',title:'A medição digital está formando sua base',description:'Os indicadores de uso começam após a autorização opcional dos membros adultos e o recebimento das primeiras interações. Nenhum histórico digital foi inventado.',tab:null});
  else if(!flags['intelligence.usage_collection']) insights.push({key:'collection_paused',title:'A coleta digital está pausada',description:'O histórico recebido continua disponível. Novas interações não serão coletadas enquanto a igreja mantiver a coleta desligada.',tab:null});
  if(cards.some(x=>x.change.percent!==null&&x.change.percent<-20&&['participants','meetings'].includes(x.key))) insights.push({key:'records_review',title:'Confira a variação dos registros',description:'Houve redução nos registros de encontros ou presenças. Verifique o calendário e os lançamentos antes de interpretar como queda de participação.',tab:'celulas',action:'Revisar encontros'});
  return {
    version:INTELLIGENCE_VERSION,period,updated_at:new Date().toISOString(),scope:{campus_id:scope.campusId,restricted_campuses:scope.campusIds,leader_groups_only:scope.cellIds!==null},
    metrics:cards,insights:insights.slice(0,3),usage:{
      modules:usageVisible?modules.filter(r=>Number(r.people)>=10).map(r=>({module:r.module,people:Number(r.people),interactions:Number(r.interactions),sessions:Number(r.sessions),suppressed:false})):[],
      daily:usageVisible?daily.map(r=>({day:r.day,people:Number(r.people)>=10?Number(r.people):null,suppressed:Number(r.people)<10})):[],
    },quality:{
      collection_enabled:!!flags['intelligence.usage_collection'],measurement_started_at:startedAt,
      last_event_at:measured.last_event_at,last_processed_at:measured.last_processed_at,
      eligible_adults:Number(consentCounts[0]?.eligible||0)>=10?Number(consentCounts[0].eligible):null,
      authorized_adults:Number(consentCounts[0]?.authorized||0)>=10?Number(consentCounts[0].authorized):null,
      minimum_sample:10,errors,retention_days:90,
      notes:['Uso digital representa uma amostra de adultos que autorizaram a coleta; não representa toda a comunidade.',
        'Os comparativos usam dias completos. As interações de hoje aparecem no horário da última interação e entram no período comparável no dia seguinte.',
        'Filtros cadastrais usam a unidade principal do cadastro. A medição digital usa a unidade da atividade registrada.',
        'Ausência de registro não comprova ausência de uso ou participação. Dados offline, bloqueios e versões antigas podem reduzir a cobertura.',
        'Conteúdo legado mistura pessoas autenticadas e navegadores. Não somar alcance de conteúdo e ativos digitais.',
        'Comparações operacionais usam os registros existentes, cuja cobertura de lançamento precisa ser conferida. A base cadastral é uma posição atual, sem MoM retroativo.',
        'A revisão ou exclusão de interações pelo titular pode alterar números históricos. Recortes com menos de dez pessoas não exibem contagens comportamentais.'],
    },
  };
}
