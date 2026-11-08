import {IntelligenceError} from './intelligenceUsage';
export const JOURNEY_FLAGS=['intelligence.activation','intelligence.member_journey','intelligence.actions','intelligence.goals'] as const;
export const VISITOR_STAGES=['NEW','CONTACTED_24H','REFERRED_TO_CELL','ATTENDING_CELL','INTEGRATED_MEMBER','ARCHIVED'];
export const ACTION_STATES=['NEW','IN_REVIEW','ACTION_LINKED','COMPLETED','DISMISSED'];
export const RESOLUTIONS=['RESOLVED','DATA_CORRECTED','NOT_APPLICABLE','ALREADY_HANDLED'];
export const GOAL_METRICS:Record<string,{label:string;flag:string}>={
 visitors_contacted:{label:'Visitantes com contato registrado',flag:'visitors.module_enabled'},
 visitors_linked:{label:'Visitantes com vínculo confirmado',flag:'visitors.module_enabled'},
 registered_participants:{label:'Participantes com presença registrada',flag:'cell_groups.module_enabled'},
};
export function validDay(value:unknown):value is string{
 return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
}
export function requireDay(value:unknown){if(!validDay(value))throw new IntelligenceError(400,'Informe uma data válida.');return value;}
export function requireVersion(value:unknown){if(!Number.isInteger(value)||Number(value)<0)throw new IntelligenceError(409,'Atualize os dados antes de salvar.');return Number(value);}
export function shortTitle(value:unknown){if(typeof value!=='string'||value.trim().length<4||value.trim().length>140||/[\x00-\x1f]/.test(value))throw new IntelligenceError(400,'Use um título objetivo entre 4 e 140 caracteres.');return value.trim();}
export function assertActionTransition(previous:string,next:string,resolution?:string){
 const allowed:Record<string,string[]>={NEW:['IN_REVIEW','DISMISSED'],IN_REVIEW:['NEW','ACTION_LINKED','COMPLETED','DISMISSED'],ACTION_LINKED:['IN_REVIEW','COMPLETED','DISMISSED'],COMPLETED:['IN_REVIEW'],DISMISSED:['IN_REVIEW']};
 if(previous!==next&&!allowed[previous]?.includes(next))throw new IntelligenceError(400,'Transição de acompanhamento inválida.');
 if(['COMPLETED','DISMISSED'].includes(next)&&!RESOLUTIONS.includes(resolution||''))throw new IntelligenceError(400,'Informe o motivo de conclusão ou descarte.');
}
export const sqlUtc=(date=new Date())=>date.toISOString().slice(0,19).replace('T',' ');
export const isoUtc=(value:any)=>value?new Date(value instanceof Date?value:String(value).includes('T')?value:String(value).replace(' ','T')+'Z').toISOString():null;
