import {randomUUID} from 'crypto';
import {getConnection,query} from '../db';
import {IntelligenceScope,scopedWhere} from './intelligenceScope';
import {IntelligenceError} from './intelligenceUsage';
import {requireVersion} from './intelligenceJourneyModel';
import {logSecurityEvent} from './auditLogService';
import {evaluateTenantFlags} from './featureFlagService';
import {enforcePermission} from './authMiddleware';
import {ADVANCED_ALERT_RULES,ADVANCED_ALERT_FLAG,ADVANCED_ALERT_VERSION,AdvancedAlertRule,defaultAdvancedConfig,validateAdvancedConfig,advancedPeriod,isDigitalAlert,addAlertDays,ROUTINE_MODULES} from './advancedAlertModel';
import {advancedRoleAllowed,advancedSourceState,advancedHash,observeAdvancedRule,AlertDb} from './advancedAlertSources';
import {dayInSaoPaulo} from './intelligenceModel';
const parse=(v:any)=>typeof v==='string'?JSON.parse(v):v;
export function advancedFinancialPermission(scope:IntelligenceScope){return enforcePermission(scope.user,'intelligence.view_financial',['SUPERADMIN','PASTOR','ADMIN','TREASURER']).allowed;}
export async function advancedRuleAvailable(scope:IntelligenceScope,campus:string,key:AdvancedAlertRule){
 if(!advancedRoleAllowed(scope,key)||(key==='financial_variation'&&!advancedFinancialPermission(scope)))return false;
 const f=(await evaluateTenantFlags(scope.organizationId,campus,'production')).flags;
 return [ADVANCED_ALERT_FLAG,'intelligence.overview','intelligence.alerts','intelligence.actions',...ADVANCED_ALERT_RULES[key].parents].every(k=>f[k]);
}
async function transaction<T>(fn:(db:any)=>Promise<T>){const db=await getConnection();try{await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');await db.beginTransaction();const r=await fn(db);await db.commit();return r;}catch(e){await db.rollback();throw e;}finally{db.release();}}
async function audit(db:any,s:IntelligenceScope,event:any,action:string,id:string,details:any){await logSecurityEvent({organizationId:s.organizationId,campusId:s.campusId,user:s.user,action,resource:'intelligence_alerts',resourceId:id,details,event,strict:true,executor:(q,p)=>db.query(q,p)});}
export async function advancedRuleOptions(scope:IntelligenceScope,campus:any){
 const result:any[]=[];const flags=(await evaluateTenantFlags(scope.organizationId,campus.id,'production')).flags;
 for(const [key,definition]of Object.entries(ADVANCED_ALERT_RULES)){
  if(!await advancedRuleAvailable(scope,campus.id,key as AdvancedAlertRule))continue;
  const {rows}=await query('SELECT * FROM intelligence_advanced_alert_rules WHERE organization_id = ? AND campus_id = ? AND rule_key = ?',[scope.organizationId,campus.id,key]);
  const {rows:last}=await query('SELECT status,result_json,period_json,rule_version,DATE_FORMAT(evaluated_at,\'%Y-%m-%dT%H:%i:%s.%fZ\') AS evaluated_at FROM intelligence_alert_evaluations WHERE organization_id = ? AND campus_id = ? AND rule_key = ? ORDER BY evaluated_at DESC,id DESC LIMIT 1',[scope.organizationId,campus.id,key]);
  const stored=rows[0],config=stored?parse(stored.config_json):defaultAdvancedConfig(key as AdvancedAlertRule);
  // Readiness does not return historical aggregate counts, which may have lost consent.
  result.push({campus_id:campus.id,campus_name:campus.name,rule_key:key,label:definition.label,advanced:true,enabled:!!stored?.enabled,configured:!!stored,version:Number(stored?.version||0),config,available_modules:Object.keys(ROUTINE_MODULES).filter(m=>flags[ROUTINE_MODULES[m as keyof typeof ROUTINE_MODULES].flag]),available_content_types:['DEVOTIONAL','STUDY_BOOK','STUDY_CHAPTER'].filter(t=>flags[t==='DEVOTIONAL'?'devotionals.module_enabled':'studies.module_enabled']),coverage:definition.coverage,period:advancedPeriod(key as AdvancedAlertRule,config),last_evaluation:last[0]?{status:last[0].status,evaluated_at:last[0].evaluated_at,period:parse(last[0].period_json),rule_version:Number(last[0].rule_version)}:null});
 }return result;
}
export async function configureAdvancedRule(scope:IntelligenceScope,body:any,event:any){
 const key=body.rule_key as AdvancedAlertRule;
 if(!['SUPERADMIN','PASTOR','ADMIN','TREASURER'].includes(scope.user.role)||!scope.campusId||!await advancedRuleAvailable(scope,scope.campusId,key))throw new IntelligenceError(403,'Configuração fora do seu acesso.');
 if(typeof body.enabled!=='boolean'||typeof body.reason!=='string'||body.reason.trim().length<8||body.reason.trim().length>240)throw new IntelligenceError(400,'Informe ativação e motivo com 8 a 240 caracteres.');
 const config=validateAdvancedConfig(key,body.config),expected=requireVersion(body.expected_version);
 return transaction(async db=>{
  await db.query('INSERT IGNORE INTO intelligence_advanced_alert_rules(organization_id,campus_id,rule_key,config_json,updated_by,updated_at) VALUES(?,?,?,?,?,UTC_TIMESTAMP(6))',[scope.organizationId,scope.campusId,key,JSON.stringify(defaultAdvancedConfig(key)),scope.user.userId]);
  const [rows]=await db.query('SELECT version FROM intelligence_advanced_alert_rules WHERE organization_id = ? AND campus_id = ? AND rule_key = ? FOR UPDATE',[scope.organizationId,scope.campusId,key]);
  if(Number(rows[0].version)!==expected)throw new IntelligenceError(409,'A configuração mudou. Atualize antes de salvar.');
  await advancedSourceState(db,scope,key,config);
  await db.query('UPDATE intelligence_advanced_alert_rules SET enabled=?,config_json=?,version=version+1,updated_by=?,updated_at=UTC_TIMESTAMP(6) WHERE organization_id = ? AND campus_id = ? AND rule_key = ?',[body.enabled,JSON.stringify(config),scope.user.userId,scope.organizationId,scope.campusId,key]);
  await audit(db,scope,event,'CONFIGURE_ADVANCED_ALERT',key,{reason:body.reason.trim(),enabled:body.enabled,config,version:expected+1});return{version:expected+1};
 });
}
async function recordEvent(db:any,scope:IntelligenceScope,id:string,version:number,kind:string,evidence:any){await db.query('INSERT INTO intelligence_alert_events(organization_id,id,alert_id,version,request_hash,kind,reason,actor_id,details_json,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6))',[scope.organizationId,randomUUID(),id,version,advancedHash([kind,evidence]),kind,kind==='SOURCE_CORRECTED'?'Condição corrigida na mesma janela':'Condição conferida nas fontes da janela',scope.user.userId,JSON.stringify(evidence)]);}
export async function evaluateAdvancedAlerts(scope:IntelligenceScope,event:any,now=new Date()){
 const results:any[]=[];
 for(const key of Object.keys(ADVANCED_ALERT_RULES) as AdvancedAlertRule[]){
  if(!await advancedRuleAvailable(scope,scope.campusId!,key))continue;
  try{results.push(await transaction(async db=>{
   const [rules]=await db.query('SELECT * FROM intelligence_advanced_alert_rules WHERE organization_id = ? AND campus_id = ? AND rule_key = ? FOR UPDATE',[scope.organizationId,scope.campusId,key]);
   const rule=rules[0];if(!rule?.enabled)return{rule_key:key,status:'awaiting_configuration'};
   const config=validateAdvancedConfig(key,parse(rule.config_json)),period=advancedPeriod(key,config,now);
   if(isDigitalAlert(key)){await db.query('INSERT IGNORE INTO intelligence_alert_privacy_revision(organization_id) VALUES(?)',[scope.organizationId]);await db.query('SELECT revision FROM intelligence_alert_privacy_revision WHERE organization_id = ? FOR SHARE',[scope.organizationId]);}
   const source=await observeAdvancedRule(db,scope,key,config,period,now),filter=scopedWhere(scope,'a','campus_id','cell_group_id');
   const [existing]=await db.query(`SELECT a.* FROM intelligence_alerts a WHERE a.organization_id = ? AND a.rule_key = ?${filter.sql} FOR UPDATE`,[scope.organizationId,key,...filter.params]);
   let opened=0,resolved=0,revised=0,suppressed=0;
   for(const item of source.observations){
    // A changed digital authorization population gets its own identity; old evidence/history/actions remain inaccessible.
    const dedup=advancedHash([scope.organizationId,scope.campusId,key,rule.version,ADVANCED_ALERT_VERSION,period.start,period.end,item.id,item.cell,isDigitalAlert(key)?source.privacy_identity:null]);
    const old=existing.find((r:any)=>r.dedup_key===dedup),evidence={...item.evidence,period,config,source_revision:source.revision,source_token:source.source_token,privacy_identity:source.privacy_identity,definition_version:ADVANCED_ALERT_VERSION,reference_at:now.toISOString()};
    if(item.match){
     const muted=existing.some((r:any)=>r.source_id===item.id&&r.cell_group_id===item.cell&&r.status==='SNOOZED'&&(!isDigitalAlert(key)||parse(r.evidence_json).privacy_identity===source.privacy_identity)&&(r.snoozed_until instanceof Date?r.snoozed_until.toISOString().slice(0,10):String(r.snoozed_until).slice(0,10))>dayInSaoPaulo(now));
     if(!old&&muted){suppressed++;continue;}
     if(!old){const id=randomUUID();await db.query('INSERT INTO intelligence_alerts(organization_id,id,campus_id,cell_group_id,rule_key,rule_version,source_id,dedup_key,evidence_json,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))',[scope.organizationId,id,scope.campusId,item.cell,key,rule.version,item.id,dedup,JSON.stringify(evidence)]);await recordEvent(db,scope,id,0,'OPENED',evidence);opened++;}
     else{
      const prior=parse(old.evidence_json),reopen=old.status==='RESOLVED',changed=prior.source_revision!==source.revision;
      const version=Number(old.version)+(reopen||changed?1:0);
      await db.query("UPDATE intelligence_alerts SET evidence_json=?,last_seen=UTC_TIMESTAMP(6),version=?,generation=generation+?,action_id=IF(?,NULL,action_id),status=IF(?,'NEW',status),resolved_at=IF(?,NULL,resolved_at) WHERE organization_id = ? AND id = ?",[JSON.stringify(evidence),version,reopen?1:0,reopen,reopen,reopen,scope.organizationId,old.id]);
      if(reopen){await recordEvent(db,scope,old.id,version,'REOPENED',evidence);opened++;}else if(changed){await recordEvent(db,scope,old.id,version,'EVIDENCE_REVISED',evidence);revised++;}
     }
    }else if(old&&!['RESOLVED','DISMISSED'].includes(old.status)){
     await db.query("UPDATE intelligence_alerts SET evidence_json=?,status='RESOLVED',resolved_at=UTC_TIMESTAMP(6),version=version+1,last_seen=UTC_TIMESTAMP(6) WHERE organization_id = ? AND id = ?",[JSON.stringify(evidence),scope.organizationId,old.id]);await recordEvent(db,scope,old.id,Number(old.version)+1,'SOURCE_CORRECTED',evidence);resolved++;
    }
   }
   const result={rule_key:key,status:source.status,period,scanned:source.observations.length,opened,resolved,revised,suppressed,note:source.note};
   // The leader's group scope participates in identity; it cannot mark another leader's evaluation complete.
   const requestHash=advancedHash([scope.organizationId,scope.campusId,key,rule.version,ADVANCED_ALERT_VERSION,period,scope.cellIds,source.revision,source.status]);
   await db.query('INSERT IGNORE INTO intelligence_alert_evaluations(organization_id,id,campus_id,rule_key,rule_version,definition_version,period_json,request_hash,status,result_json,evaluated_at) VALUES(?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6))',[scope.organizationId,randomUUID(),scope.campusId,key,rule.version,ADVANCED_ALERT_VERSION,JSON.stringify(period),requestHash,source.status,JSON.stringify(result)]);
   await db.query('UPDATE intelligence_advanced_alert_rules SET last_attempted_at=UTC_TIMESTAMP(6) WHERE organization_id = ? AND campus_id = ? AND rule_key = ?',[scope.organizationId,scope.campusId,key]);
   await audit(db,scope,event,'EVALUATE_ADVANCED_ALERT',key,{...result,source_revision:source.revision});return result;
  }));}catch(e){if(e instanceof IntelligenceError&&e.status!==503)throw e;console.error('Advanced alert source unavailable',{rule:key,name:(e as Error).name});results.push({rule_key:key,status:'source_error'});}
 }return results;
}
export async function assertAdvancedAlertAccess(db:AlertDb,scope:IntelligenceScope,row:any,lock=false){
 const key=row.rule_key as AdvancedAlertRule,narrow={...scope,campusId:row.campus_id,campusIds:[row.campus_id]};
 if(!await advancedRuleAvailable(narrow,row.campus_id,key))throw new IntelligenceError(404,'Alerta não encontrado no acesso atual.');
 if(key==='participation'){const [cells]=await db.query("SELECT id FROM cell_groups WHERE organization_id = ? AND id = ? AND COALESCE(campus_id,'campus_sede') = ?",[scope.organizationId,row.cell_group_id,row.campus_id]);if(!cells.length)throw new IntelligenceError(404,'O grupo mudou de unidade.');}
 const e=parse(row.evidence_json),config=validateAdvancedConfig(key,e.config);
 if(isDigitalAlert(key)&&lock)await db.query('SELECT revision FROM intelligence_alert_privacy_revision WHERE organization_id = ? FOR SHARE',[scope.organizationId]);
 try{
  const state=await advancedSourceState(db,narrow,key,config,e.period);
  if(e.source_token!==state.token||(isDigitalAlert(key)&&(dayInSaoPaulo()<addAlertDays(e.period.end,8)||Date.parse(dayInSaoPaulo())-Date.parse(e.period.start)>89*86400000)))throw new IntelligenceError(404,'Evidência precisa ser reavaliada após mudança de fonte ou autorização.');
  if(key==='financial_variation'){const source=await observeAdvancedRule(db,narrow,key,config,e.period);if(source.status!=='evaluated'||source.revision!==e.source_revision)throw new IntelligenceError(404,'O livro mudou. Avalie novamente a regra.');}
 }catch(error){if(error instanceof IntelligenceError&&error.status===403)throw new IntelligenceError(404,'Fonte não disponível no acesso atual.');throw error;}
}
export async function advancedAlertSource(scope:IntelligenceScope,id:string){
 // Import lazily to keep source validation independent from the legacy catalog.
 const {alertContext}=await import('./intelligenceAlertAccess');const db=await getConnection();
 try{const row=await alertContext(scope,id,db),e=parse(row.evidence_json);if(!Object.hasOwn(ADVANCED_ALERT_RULES,row.rule_key))throw new IntelligenceError(400,'Use o módulo de origem desta regra.');const source=await observeAdvancedRule(db,{...scope,campusId:row.campus_id,campusIds:[row.campus_id]},row.rule_key,e.config,e.period);const item=source.observations.find(o=>o.id===row.source_id&&o.cell===(row.cell_group_id||null));if(!item)throw new IntelligenceError(409,'A fonte precisa de nova avaliação.');return{rule_key:row.rule_key,period:e.period,evidence:item.evidence,reference_at:new Date().toISOString(),changed_since_evaluation:source.revision!==e.source_revision,status:source.status};}finally{db.release();}
}
