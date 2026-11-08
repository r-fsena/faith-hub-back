import { APIGatewayProxyEvent, SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { apiResponse, query, getConnection } from '../db';
import { requireAuth, enforceRole, enforcePermission } from '../services/authMiddleware';
import { intelligenceScope } from '../services/intelligenceScope';
import { evaluateTenantFlags } from '../services/featureFlagService';
import { checkRateLimit } from '../services/rateLimiter';
import { intelligenceOverview } from '../services/intelligenceOverview';
import { usagePreference, setUsagePreference, acceptUsage, processUsage, IntelligenceError } from '../services/intelligenceUsage';
import { corsPreflight } from './corsPreflight';
import { SAFE_ID, dayInSaoPaulo, subjectKey } from '../services/intelligenceModel';
import {activationFunnel,communityJourney} from '../services/intelligenceJourneys';
import {listWelcomeVisitors,welcomeOptions,mutateWelcome} from '../services/intelligenceWelcome';
import {actionOptions,listActions,saveAction,listGoals,saveGoal} from '../services/intelligenceActions';
import {intelligenceOperations,FINANCE_ROLES,OPERATIONS_ROLES} from '../services/intelligenceOperations';

export async function intelligenceHandler(event:APIGatewayProxyEvent) {
  try {
    const method=(event as any).requestContext?.http?.method||event.httpMethod;
    if(method==='OPTIONS')return corsPreflight();
    const auth=await requireAuth(event);if('errorResponse' in auth)return auth.errorResponse;
    const path=((event as any).rawPath||event.path||'').split('/').filter(Boolean);
    const ownPreference=path.slice(-2).join('/')==='me/usage';
    // Authenticated members sharing the church's Wi-Fi do not consume each other's rate bucket.
    const rate=await checkRateLimit(event,{maxRequests:60,windowSeconds:60,identifierPrefix:`intelligence-${ownPreference?'privacy':'data'}:${subjectKey(auth.user.organizationId,auth.user.userId).slice(0,24)}`});if(!rate.allowed)return rate.errorResponse!;
    if((event.body||'').length>32768)return apiResponse(413,{message:'Solicitação muito grande.'});
    const body=event.body?JSON.parse(event.body):{};
    if(!body||typeof body!=='object'||Array.isArray(body))return apiResponse(400,{message:'Envie um objeto JSON válido.'});
    const scope=await intelligenceScope(event,auth.user,body);if('statusCode' in scope)return scope;
    if(ownPreference){
      const role=enforceRole(auth.user,['SUPERADMIN','PASTOR','ADMIN','TREASURER','LEADER','VOLUNTEER','MEMBER']);if(!role.allowed)return role.errorResponse!;
      const flags=await evaluateTenantFlags(scope.organizationId,scope.campusId,'production');
      if(method==='GET')return apiResponse(200,{...await usagePreference(scope.organizationId,auth.user),collection_enabled:!!flags.flags['intelligence.usage_collection']},{'Cache-Control':'no-store'});
      if(method==='POST'){
        if(body.allowed&&!flags.flags['intelligence.usage_collection'])return apiResponse(403,{message:'A coleta está pausada nesta igreja.'});
        return apiResponse(200,await setUsagePreference(scope.organizationId,auth.user,body,event),{'Cache-Control':'no-store'});
      }
    }
    const action=path.at(-1);
    if(action==='events'&&method==='POST'){
      const role=enforceRole(auth.user,['SUPERADMIN','PASTOR','ADMIN','TREASURER','LEADER','VOLUNTEER','MEMBER']);if(!role.allowed)return role.errorResponse!;
      if(!scope.campusId)return apiResponse(400,{message:'Informe a unidade da interação.'});
      const flags=await evaluateTenantFlags(scope.organizationId,scope.campusId,'production');
      return apiResponse(202,await acceptUsage(scope.organizationId,scope.campusId,auth.user,body,flags.flags));
    }
    const role=enforceRole(auth.user,['SUPERADMIN','PASTOR','ADMIN','TREASURER','LEADER']);if(!role.allowed)return role.errorResponse!;
    const permission=enforcePermission(auth.user,'intelligence.view',['SUPERADMIN','PASTOR','ADMIN','TREASURER','LEADER']);if(!permission.allowed)return permission.errorResponse!;
    const flags=await evaluateTenantFlags(scope.organizationId,scope.campusId,'production');
    if(!flags.flags['intelligence.overview'])return apiResponse(403,{message:'O módulo de Inteligência não está habilitado para esta igreja.'});
    const route=path.slice(path.indexOf('intelligence')+1);
    const enabled=(key:string,parent?:string)=>{if(!flags.flags[key]||(parent&&!flags.flags[parent]))throw new IntelligenceError(403,'Este recurso não está habilitado no plano ou escopo selecionado.');};
    const respond=(data:any)=>apiResponse(200,data,{'Cache-Control':'no-store'});
    if(['finance','operations','units'].includes(route[0])&&route.length===1&&method==='GET'){
      const view=route[0] as 'finance'|'operations'|'units';
      const access=enforceRole(auth.user,view==='operations'?OPERATIONS_ROLES:FINANCE_ROLES);if(!access.allowed)return access.errorResponse!;
      if(view==='finance'){
        enabled('intelligence.finance','financial.cashflow_ledger');enabled('financial.module_enabled');
        const financial=enforcePermission(auth.user,'intelligence.view_financial',FINANCE_ROLES);if(!financial.allowed)return financial.errorResponse!;
      }else if(view==='operations')enabled('intelligence.operations');
      else{enabled('intelligence.multicampus','system.multicampus_enabled');}
      return respond(await intelligenceOperations(scope,event.queryStringParameters?.period||'month',view));
    }
    // Treasury access is restricted to its financial views, never the pastoral/member panels.
    if(auth.user.role==='TREASURER')return apiResponse(403,{message:'Seu perfil de tesouraria permite consultar somente Finanças e seu consolidado de unidades.'});
    if(route[0]==='activation'&&method==='GET'){enabled('intelligence.activation','members.module_enabled');return respond(await activationFunnel(scope,flags.flags,event.queryStringParameters?.period||'month'));}
    if(route[0]==='community'&&method==='GET'){enabled('intelligence.member_journey','visitors.module_enabled');return respond(await communityJourney(scope,event.queryStringParameters?.period||'month',Number(event.queryStringParameters?.window_days||7),flags.flags));}
    if(route[0]==='welcome'){
      enabled('intelligence.member_journey','visitors.module_enabled');
      if(route[1]==='visitors'&&route.length===2&&method==='GET')return respond(await listWelcomeVisitors(scope,event.queryStringParameters||{}));
      if(route[1]==='visitors'&&route[2]&&route[3]==='options'&&method==='GET')return respond(await welcomeOptions(scope,route[2],event.queryStringParameters?.search||'',!!flags.flags['cell_groups.module_enabled']));
      if(route[1]==='visitors'&&route[2]&&route.length===3&&method==='POST'){
        if(['refer','link'].includes(body.operation)||['REFERRED_TO_CELL','ATTENDING_CELL','INTEGRATED_MEMBER'].includes(body.stage))enabled('cell_groups.module_enabled');
        return respond(await mutateWelcome(scope,route[2],body,event));
      }
    }
    if(route[0]==='options'&&method==='GET'){
      if(!flags.flags['intelligence.actions']&&!flags.flags['intelligence.goals'])throw new IntelligenceError(403,'Acompanhamento não está habilitado.');
      return respond(await actionOptions(scope,flags.flags));
    }
    if(route[0]==='actions'){
      enabled('intelligence.actions');
      if(method==='GET'&&route.length===1)return respond(await listActions(scope,flags.flags,Number(event.queryStringParameters?.page||0),event.queryStringParameters?.status||'all'));
      const management=enforcePermission(auth.user,'intelligence.manage_actions',['SUPERADMIN','PASTOR','ADMIN','LEADER']);if(!management.allowed)return management.errorResponse!;
      if((method==='POST'&&route.length===1)||(method==='PATCH'&&route.length===2))return respond(await saveAction(scope,flags.flags,body,event,route[1]));
    }
    if(route[0]==='goals'){
      enabled('intelligence.goals');
      if(method==='GET'&&route.length===1)return respond(await listGoals(scope,flags.flags,Number(event.queryStringParameters?.page||0)));
      const management=enforcePermission(auth.user,'intelligence.manage_actions',['SUPERADMIN','PASTOR','ADMIN','LEADER']);if(!management.allowed)return management.errorResponse!;
      if((method==='POST'&&route.length===1)||(method==='PATCH'&&route.length===2))return respond(await saveGoal(scope,flags.flags,body,event,route[1]));
    }
    if(action==='overview'&&method==='GET')return apiResponse(200,await intelligenceOverview(scope,flags.flags,event.queryStringParameters?.period||'month'),{'Cache-Control':'no-store'});
    return apiResponse(404,{message:'Recurso não encontrado.'});
  }catch(error){
    if(error instanceof IntelligenceError)return apiResponse(error.status,{message:error.message});
    if(error instanceof SyntaxError)return apiResponse(400,{message:'JSON inválido.'});
    if(error instanceof Error && /inválid|janela|Período|disponível|contratado/.test(error.message))return apiResponse(400,{message:error.message});
    console.error('Inteligência indisponível',{name:(error as Error)?.name});
    return apiResponse(503,{message:'Não foi possível atualizar a inteligência. Os módulos continuam disponíveis.'});
  }
}
export async function intelligenceWorker(event:SQSEvent):Promise<SQSBatchResponse>{
  const batchItemFailures:Array<{itemIdentifier:string}>=[];
  for(const record of event.Records){
    try{await processUsage(JSON.parse(record.body));}catch(error){console.error('Falha na medição de uso',{messageId:record.messageId,name:(error as Error)?.name});batchItemFailures.push({itemIdentifier:record.messageId});}
  }
  return {batchItemFailures};
}
export async function maintainIntelligence(){
  // System-only scheduler: enumerate tenant IDs, then scope every data query to that tenant.
  const {rows:organizations}=await query('SELECT id FROM organizations ORDER BY id');
  let failures=0;
  for(const organization of organizations){
    const org=String(organization.id);if(!SAFE_ID.test(org))continue;
    try {
    await query('DELETE FROM intelligence_activity_daily WHERE organization_id = ? AND activity_date < DATE_SUB(?,INTERVAL 90 DAY)',[org,dayInSaoPaulo()]);
    await query('DELETE FROM intelligence_event_receipts WHERE organization_id = ? AND received_at < DATE_SUB(UTC_TIMESTAMP(),INTERVAL 90 DAY)',[org]);
    await query('DELETE FROM intelligence_invitation_events WHERE organization_id = ? AND occurred_at < DATE_SUB(UTC_TIMESTAMP(),INTERVAL 90 DAY)',[org]);
    await query("DELETE FROM content_engagement_events WHERE organization_id = ? AND source = 'PWA_INTELLIGENCE_V1' AND occurred_at < DATE_SUB(UTC_TIMESTAMP(),INTERVAL 90 DAY)",[org]);
    const flags=await evaluateTenantFlags(org,null,'production');if(!flags.flags['intelligence.overview'])continue;
    const db=await getConnection();
    try {
      await db.beginTransaction();
      await db.query('DELETE FROM intelligence_member_snapshots WHERE organization_id = ? AND snapshot_date = ?',[org,dayInSaoPaulo()]);
      await db.query(`INSERT INTO intelligence_member_snapshots(organization_id,campus_id,snapshot_date,cell_group_id,active_members)
      SELECT organization_id,COALESCE(campus_id,'campus_sede'),?,COALESCE(cell_group_id,''),COUNT(DISTINCT id) FROM members
      WHERE organization_id = ? AND UPPER(status) IN ('ACTIVE','ATIVO') AND UPPER(role) NOT IN ('VISITOR','VISITANTE')
      GROUP BY organization_id,COALESCE(campus_id,'campus_sede'),COALESCE(cell_group_id,'')
      ON DUPLICATE KEY UPDATE active_members=VALUES(active_members)`,[dayInSaoPaulo(),org]);
      await db.commit();
    }catch(error){await db.rollback();throw error;}finally{db.release();}
    await query('DELETE FROM intelligence_member_snapshots WHERE organization_id = ? AND snapshot_date < DATE_SUB(?,INTERVAL 24 MONTH)',[org,dayInSaoPaulo()]);
    } catch {failures++;console.error('Manutenção de inteligência pendente',{organizationId:org});}
  }
  if(failures)throw Error(`INTELLIGENCE_MAINTENANCE_FAILURES:${failures}`);
  return {organizations:organizations.length};
}
