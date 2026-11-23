import {IntelligenceError} from './intelligenceUsage';
import {dayInSaoPaulo,utcBoundary,IntelligencePeriod} from './intelligenceModel';

export const ADVANCED_ALERT_VERSION='2026-11-23.a2-v1';
export const ADVANCED_ALERT_FLAG='intelligence.alerts_advanced';
export const ROUTINE_MODULES={devotionals:{label:'Devocionais',flag:'devotionals.module_enabled'},events:{label:'Eventos',flag:'events.module_enabled'},store:{label:'Loja',flag:'pdv.module_enabled'},volunteers:{label:'Escalas',flag:'volunteers.module_enabled'}} as const;
export const ADVANCED_ALERT_RULES={
 participation:{label:'Queda de participação registrada',parents:['intelligence.calendar','intelligence.history','members.module_enabled','cell_groups.module_enabled'],tab:'intelligence',domain:'participation',coverage:'Compara oportunidades elegíveis de dois períodos fechados, com calendário e vínculos históricos conferidos.'},
 activation:{label:'Ativação digital abaixo do objetivo',parents:['intelligence.activation','intelligence.usage_collection','members.module_enabled','content.analytics_dashboard'],tab:'intelligence',domain:'digital',coverage:'Coorte mensal de adultos autorizados, com convite solicitado e sete dias completos para primeiro uso qualificado.'},
 content_completion:{label:'Conteúdo iniciado sem conclusão observada',parents:['intelligence.usage_collection','content.analytics_dashboard','members.module_enabled'],tab:'intelligence',domain:'digital',coverage:'Mesmo usuário e conteúdo, início no mês encerrado e conclusão em até sete dias; somente amostra autorizada.'},
 module_routine:{label:'Módulo sem rotina digital observada',parents:['intelligence.usage_collection','members.module_enabled'],tab:'intelligence',domain:'digital',coverage:'Dias com uso observado do módulo no mês encerrado; depende de amostra autorizada e captura contínua. Não comprova ausência de uso.'},
 financial_variation:{label:'Variação financeira no livro registrado',parents:['intelligence.finance','financial.module_enabled','financial.cashflow_ledger','financial.accounts_ledger'],tab:'intelligence',domain:'financial',coverage:'Compara valores operacionais liquidados, líquidos de correções/devoluções. Transferências são excluídas. Divergência bancária aguarda a conciliação F3.'}
} as const;
export type AdvancedAlertRule=keyof typeof ADVANCED_ALERT_RULES;
export const isAdvancedRule=(key:string):key is AdvancedAlertRule=>Object.hasOwn(ADVANCED_ALERT_RULES,key);
export const isFinancialAlert=(key:string)=>key==='financial_variation';
export const isDigitalAlert=(key:string)=>isAdvancedRule(key)&&ADVANCED_ALERT_RULES[key].domain==='digital';
export type AdvancedConfig={window_days?:number;min_samples:number;min_occurrences?:number;min_coverage_percent?:number;min_drop_pp?:number;target_percent?:number;content_type?:string;modules?:string[];min_active_days?:number;direction?:string;threshold_percent?:number;min_change_cents?:number};
export const defaultAdvancedConfig=(key:AdvancedAlertRule):AdvancedConfig=>key==='participation'?{window_days:28,min_samples:5,min_occurrences:2,min_coverage_percent:90,min_drop_pp:15}:key==='activation'?{target_percent:40,min_samples:10}:key==='content_completion'?{target_percent:40,min_samples:10,content_type:'DEVOTIONAL'}:key==='module_routine'?{min_samples:10,min_active_days:2,modules:['devotionals']}:{window_days:28,min_samples:1,direction:'income_drop',threshold_percent:20,min_change_cents:10000};
export function validateAdvancedConfig(key:AdvancedAlertRule,input:any):AdvancedConfig{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new IntelligenceError(400,'Informe a configuração da regra.');
 const defaults=defaultAdvancedConfig(key),allowed=Object.keys(defaults);if(Object.keys(input).some(k=>!allowed.includes(k)))throw new IntelligenceError(400,'Há parâmetros não reconhecidos nesta regra.');
 const c:AdvancedConfig={...defaults,...input};const integer=(field:keyof AdvancedConfig,min:number,max:number)=>{const n=c[field];if(!Number.isSafeInteger(n)||Number(n)<min||Number(n)>max)throw new IntelligenceError(400,'Confira os limites e as quantidades mínimas da regra.');};
 integer('min_samples',isDigitalAlert(key)?10:1,10000);
 if(c.window_days!==undefined&&![7,28].includes(c.window_days))throw new IntelligenceError(400,'Escolha uma janela fechada de 7 ou 28 dias.');
 if(key==='participation'){integer('min_occurrences',1,100);integer('min_coverage_percent',80,100);integer('min_drop_pp',1,100);}
 if(key==='activation'||key==='content_completion')integer('target_percent',1,100);
 if(key==='content_completion'&&!['DEVOTIONAL','STUDY_BOOK','STUDY_CHAPTER'].includes(c.content_type||''))throw new IntelligenceError(400,'Escolha devocionais ou estudos.');
 if(key==='module_routine'){integer('min_active_days',1,28);if(!Array.isArray(c.modules)||!c.modules.length||c.modules.length>4||c.modules.some(m=>!Object.hasOwn(ROUTINE_MODULES,m)))throw new IntelligenceError(400,'Escolha os módulos instrumentados para observar.');c.modules=[...new Set(c.modules)].sort();}
 if(key==='financial_variation'){integer('threshold_percent',1,100);integer('min_change_cents',1,999999999999);if(!['income_drop','expense_rise'].includes(c.direction||''))throw new IntelligenceError(400,'Escolha queda de receitas ou aumento de despesas. Conciliação bancária não está disponível nesta regra.');}
 return c;
}
export const addAlertDays=(day:string,n:number)=>new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
export function advancedPeriod(key:AdvancedAlertRule,c:AdvancedConfig,now=new Date()):IntelligencePeriod{
 const today=dayInSaoPaulo(now);let end:string,start:string,previousStart:string;
 if(isDigitalAlert(key)){end=today.slice(0,7)+'-01';const [y,m]=end.split('-').map(Number);start=new Date(Date.UTC(y,m-2,1)).toISOString().slice(0,10);previousStart=new Date(Date.UTC(y,m-3,1)).toISOString().slice(0,10);}
 else{const weekday=new Date(today+'T12:00:00Z').getUTCDay();end=addAlertDays(today,-((weekday+6)%7));start=addAlertDays(end,-c.window_days!);previousStart=addAlertDays(start,-c.window_days!);}
 return{preset:isDigitalAlert(key)?'last_month':'closed_'+c.window_days+'d',start,end,previousStart,previousEnd:start,comparison:isDigitalAlert(key)?'Coorte mensal encerrada':'Janelas fechadas de igual duração',timezone:'America/Sao_Paulo'};
}
export const alertSqlTime=(day:string)=>utcBoundary(day).slice(0,19).replace('T',' ');
export function safeAlertCount(value:any){const n=Number(value??0);if(!Number.isSafeInteger(n)||n<0)throw new IntelligenceError(503,'A fonte retornou uma quantidade inválida.');return n;}
export const percent=(n:number,d:number)=>d>0?Math.round(n/d*1000)/10:null;
/** Protect counts, adjacent stages, complements and the remainder of other campuses. */
export function protectedAlertSample(values:number[],minimum=10){
 const small=(n:number)=>n>0&&n<10;
 return values.length>0&&values[0]>=minimum&&values.every(n=>Number.isSafeInteger(n)&&n>=0&&!small(n))&&values.every((v,i)=>values.slice(i+1).every(other=>!small(Math.abs(v-other))));
}
export function financialAlertMatch(current:number,previous:number,c:AdvancedConfig){
 if(!Number.isSafeInteger(current)||!Number.isSafeInteger(previous))throw new IntelligenceError(503,'Agregado financeiro fora dos limites.');
 const delta=c.direction==='income_drop'?previous-current:current-previous;if(!Number.isSafeInteger(delta))throw new IntelligenceError(503,'Variação financeira fora dos limites.');
 return{match:delta>=c.min_change_cents!&&(previous>0?delta*100/previous>=c.threshold_percent!:c.direction==='expense_rise'),delta_cents:delta,change_percent:previous>0?Math.round(delta/previous*1000)/10:null};
}
