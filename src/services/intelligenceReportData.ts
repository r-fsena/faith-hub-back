import {createHash} from 'crypto';
import {intelligenceOverview} from './intelligenceOverview';
import {communityJourney} from './intelligenceJourneys';
import {intelligenceOperations} from './intelligenceOperations';
import {memberHistory} from './memberHistory';
import {memberHistoryRevision} from './memberHistoryCorrections';
import {IntelligenceScope} from './intelligenceScope';
import {IntelligenceError} from './intelligenceUsage';
import {IntelligencePeriod,withIntelligencePeriod} from './intelligenceModel';
export const REPORT_VERSION='2026-11-17.h1';
export const REPORT_MODELS={executive:'Resumo executivo',financial:'Gestão financeira',operations:'Operação e unidades',community:'Comunidade e acolhimento'};
export type ReportModel=keyof typeof REPORT_MODELS;
export type ReportRow={section:string;metric:string;unit:string;current:number|null;previous:number|null;status:string;definition:string};
export interface ReportData {title:string;organization:string;scopeLabel:string;period:IntelligencePeriod;generatedAt:string;definitionVersion:string;revision:string;rows:ReportRow[];notes:string[];containsDigital:boolean}
const sourceLabel=(key:string)=>({finance:'Tesouraria',events:'Eventos',store:'Loja',stock:'Estoque',teams:'Escalas',kids:'Kids',kids_turns:'Turnos Kids'} as Record<string,string>)[key]||key;
const number=(n:unknown):number|null=>typeof n==='number'&&Number.isFinite(n)?n:null;
function metric(row:any,section:string):ReportRow{return{section,metric:row.title,unit:row.unit||'count',current:number(row.value),previous:number(row.previous),status:row.status||row.coverage||'registered_records',definition:row.definition||''};}
export async function collectReportData(scope:IntelligenceScope,flags:Record<string,boolean>,model:ReportModel,period:IntelligencePeriod,organization:string,maximumFeatures?:Record<string,string[]>):Promise<ReportData>{
 return withIntelligencePeriod(period,async()=>{
  const rows:ReportRow[]=[],notes:string[]=[];
  const includeHistory=['executive','community'].includes(model)&&flags['intelligence.history']&&flags['members.module_enabled'];
  const historyRevision=includeHistory?await memberHistoryRevision(scope.organizationId):null;
  if(model==='executive'){
   const data=await intelligenceOverview(scope,flags,period.preset);rows.push(...data.metrics.map(r=>metric(r,'Resumo executivo')));notes.push(...data.quality.notes);
   if(data.quality.errors.length)notes.push('Há fontes indisponíveis nesta revisão; valores indisponíveis não representam zero.');
  }else if(model==='financial'||model==='operations'){
   const data=await intelligenceOperations(scope,period.preset,model==='financial'?'finance':'operations',true,maximumFeatures);
   if(model==='financial'&&data.sources.finance?.status!=='available')throw new IntelligenceError(503,'A fonte financeira não está disponível. O relatório aguarda uma fonte válida.');
   for(const [key,source]of Object.entries(data.sources) as Array<[string,any]>)if(model==='financial'?key==='finance':key!=='finance')for(const row of source.metrics)rows.push({...metric(row,sourceLabel(key)),status:source.status});
   notes.push(...data.notes);if(data.errors.length)notes.push('Há fontes indisponíveis; os totais apresentados não representam essas fontes.');
   for(const unit of data.units)for(const [key,source]of Object.entries(unit.sources) as Array<[string,any]>)if(model==='financial'?key==='finance':key!=='finance')for(const row of source.metrics)rows.push({...metric(row,`${unit.name} · ${sourceLabel(key)}`),status:source.status});
  }else{
   const data=await communityJourney(scope,period.preset,7,flags);
   const labels:Record<string,string>={registered:'Visitas registradas',unknown_history:'Histórico desconhecido',mature:'Janelas encerradas',contacted:'Contato registrado',linked:'Vínculo registrado',attended:'Presença registrada',integrated:'Integração confirmada',contact_percent:'Contato em janelas encerradas'};
   for(const cohort of data.cohorts)for(const [key,label]of Object.entries(labels))rows.push({section:`Comunidade · ${cohort.cohort}`,metric:label,unit:key==='contact_percent'?'percent':'count',current:number((cohort as any)[key]),previous:null,status:'registered_records',definition:'Coorte por primeira visita informada; somente histórico verificável. Janela de acompanhamento de 7 dias.'});
   for(const week of data.participation)for(const [key,label]of Object.entries({meetings:'Encontros lançados',groups_recorded:'Grupos com lançamento',participants:'Participantes registrados'}))rows.push({section:`Participação · ${week.week}`,metric:label,unit:'count',current:number((week as any)[key]),previous:null,status:'partial_coverage',definition:'Presenças lançadas; não presume oportunidades ou ausência de pessoas.'});
   notes.push(...data.definitions);
  }
  if(includeHistory){
   const history=await memberHistory(scope,period.preset);
   rows.push({section:'Histórico cadastral',metric:'Membros ativos no fechamento',unit:'count',current:history.snapshots.current,previous:history.snapshots.previous,status:history.snapshots.current===null?'unknown_history':'observed',definition:`Revisão histórica ${history.revision}. Posição na data de fechamento pela vigência revisada; a linha de base não comprova o passado.`});
   for(const [key,label]of Object.entries({created_records:'Cadastros criados',removed_records:'Cadastros removidos',status_changes:'Mudanças de situação',campus_changes:'Mudanças de unidade',cell_changes:'Mudanças de célula'}))rows.push({section:'Histórico cadastral',metric:label,unit:'count',current:history.counts[key]??0,previous:null,status:'registered_records',definition:`Revisão histórica ${history.revision}. Alterações observadas no sistema pela vigência corrigida, sem presumir a chegada à igreja.`});
   notes.push(`Histórico cadastral: revisão ${history.revision}${history.revised_at?`, revisado em ${history.revised_at}`:''}. Arquivos anteriores preservam os números da revisão em que foram gerados.`);
   if((await memberHistoryRevision(scope.organizationId)).revision!==historyRevision!.revision)throw new IntelligenceError(409,'O histórico mudou durante a geração. Gere uma nova revisão do relatório.');
  }
  if(rows.length>20000)throw new IntelligenceError(413,'O relatório excede 20 mil linhas. Restrinja o escopo ou o período.');
  const data:ReportData={title:REPORT_MODELS[model],organization,scopeLabel:scope.campusId?'Unidade selecionada':`${scope.campusIds?.length||0} unidades autorizadas${scope.cellIds!==null?' · somente grupos permitidos':''}`,period,generatedAt:new Date().toISOString(),definitionVersion:REPORT_VERSION,revision:'',rows,notes:[...new Set(notes)],containsDigital:model==='executive'};
  data.revision=createHash('sha256').update(JSON.stringify({rows,notes:data.notes,period,definitionVersion:REPORT_VERSION})).digest('hex');return data;
 });
}
