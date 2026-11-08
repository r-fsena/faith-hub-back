import {apiResponse,getConnection,query} from '../db';
import {requireAuth,enforceRole} from './authMiddleware';
import {intelligenceScope} from './intelligenceScope';
import {listWelcomeVisitors,mutateWelcome,welcomeVisitor,trackNewWelcome} from './intelligenceWelcome';
import {evaluateTenantFlags} from './featureFlagService';
import {IntelligenceError} from './intelligenceUsage';
import {validDay} from './intelligenceJourneyModel';
import {safeIdentifier,dayInSaoPaulo} from './intelligenceModel';
import {checkRateLimit} from './rateLimiter';
import {logSecurityEvent} from './auditLogService';
import {randomUUID} from 'crypto';
const roles=['SUPERADMIN','PASTOR','ADMIN','LEADER'];
function failure(error:any){return error instanceof IntelligenceError?apiResponse(error.status,{error:error.message,message:error.message}):error instanceof SyntaxError?apiResponse(400,{error:'JSON inválido.'}):apiResponse(503,{error:'Não foi possível atualizar o acolhimento. Tente novamente.'});}
export async function privateWelcomeEndpoint(event:any,operation:'list'|'stage'|'refer'|'archive'){
 try{
  const auth=await requireAuth(event);if('errorResponse'in auth)return auth.errorResponse;
  const role=enforceRole(auth.user,roles);if(!role.allowed)return role.errorResponse!;
  const body=JSON.parse(event.body||'{}');const scope=await intelligenceScope(event,auth.user,body);if('statusCode'in scope)return scope;
  const evaluated=await evaluateTenantFlags(scope.organizationId,scope.campusId,'production');
  if(!evaluated.flags['visitors.module_enabled'])return apiResponse(403,{error:'Acolhimento não está disponível no plano.'});
  if((operation==='refer'||['REFERRED_TO_CELL','ATTENDING_CELL','INTEGRATED_MEMBER'].includes(body.stage))&&!evaluated.flags['cell_groups.module_enabled'])return apiResponse(403,{error:'Células não estão disponíveis no plano.'});
  if(operation==='list')return apiResponse(200,(await listWelcomeVisitors(scope,event.queryStringParameters||{})).visitors,{'Cache-Control':'no-store'});
  const id=event.pathParameters?.id||event.pathParameters?.visitorId;
  if(operation==='archive'){
   const visitor=await welcomeVisitor(scope,id);
   // Archive through an explicit, audited operation. The version still protects concurrent updates.
   if(!body.expected_version&&body.expected_version!==0&&evaluated.flags['intelligence.member_journey'])throw new IntelligenceError(409,'Atualize a tela para arquivar a versão atual do visitante.');
  }
  const result=await mutateWelcome(scope,id,{...body,operation:operation==='refer'?'refer':'stage',...(operation==='archive'?{stage:'ARCHIVED'}:{})},event,!!evaluated.flags['intelligence.member_journey']);
  return apiResponse(200,result,{'Cache-Control':'no-store'});
 }catch(error){return failure(error);}
}

export async function createWelcomeVisitor(event:any){
 try{
  if((event.body||'').length>16384)throw new IntelligenceError(413,'Solicitação muito grande.');
  const body=JSON.parse(event.body||'{}');if(!body||typeof body!=='object'||Array.isArray(body))throw new IntelligenceError(400,'Envie um cadastro válido.');
  const publicRate=await checkRateLimit(event,{maxRequests:15,windowSeconds:60,identifierPrefix:'public_visitor'});if(!publicRate.allowed)return publicRate.errorResponse!;
  const name=typeof body.name==='string'?body.name.trim():'',phone=typeof body.phone==='string'?body.phone.replace(/\D/g,''):'';
  if(name.length<2||name.length>255||phone.length<10||phone.length>20)throw new IntelligenceError(400,'Informe nome e telefone válidos.');
  if(body.email&&(typeof body.email!=='string'||body.email.length>255||!/^\S+@\S+\.\S+$/.test(body.email)))throw new IntelligenceError(400,'E-mail inválido.');
  if(body.neighborhood&&(typeof body.neighborhood!=='string'||body.neighborhood.length>100))throw new IntelligenceError(400,'Bairro inválido.');
  if(body.notes&&(typeof body.notes!=='string'||body.notes.length>2000))throw new IntelligenceError(400,'Observação muito longa.');
  const origin=body.origin_channel||'SUNDAY_SERVICE';if(!['SUNDAY_SERVICE','CELL_INVITE','EVENT','PWA_APP','OTHER'].includes(origin))throw new IntelligenceError(400,'Origem inválida.');
  const firstVisit=body.first_visit_date||dayInSaoPaulo();if(!validDay(firstVisit)||firstVisit>dayInSaoPaulo())throw new IntelligenceError(400,'Informe uma primeira visita válida, sem data futura.');
  let org=body.organization_id,campus=body.campus_id,user:any=null,cellId:string|null=null,leaderId:string|null=null;
  if(event.headers?.Authorization||event.headers?.authorization){
   const auth=await requireAuth(event);if('errorResponse'in auth)return auth.errorResponse;
   const allowed=enforceRole(auth.user,roles);if(!allowed.allowed)return allowed.errorResponse!;
   const scope=await intelligenceScope(event,auth.user,body);if('statusCode'in scope)return scope;
   org=scope.organizationId;campus=scope.campusId;user=auth.user;
   if(scope.cellIds){
    const candidates=scope.cellIds.filter((id:string)=>!body.cell_group_id||id===body.cell_group_id);
    if(candidates.length!==1)throw new IntelligenceError(400,'Selecione explicitamente um dos seus grupos para cadastrar o visitante.');
    const {rows}=await query('SELECT id,campus_id,leader_id FROM cell_groups WHERE organization_id = ? AND id = ?',[org,candidates[0]]);
    if(!rows.length||rows[0].campus_id!==campus)throw new IntelligenceError(403,'Grupo fora da unidade selecionada.');
    cellId=rows[0].id;leaderId=rows[0].leader_id;
   }
  }
  if(!safeIdentifier(org)||!safeIdentifier(campus))throw new IntelligenceError(400,'Informe igreja e unidade válidas.');
  const {rows:campuses}=await query('SELECT id FROM campuses WHERE organization_id = ? AND id = ?',[org,campus]);if(!campuses.length)throw new IntelligenceError(404,'Igreja ou unidade não encontrada.');
  const evaluated=await evaluateTenantFlags(org,campus,'production');if(!evaluated.flags['visitors.module_enabled'])throw new IntelligenceError(403,'Recepção indisponível para esta igreja.');
  const db=await getConnection();try{await db.beginTransaction();const id=randomUUID();
   await db.query(`INSERT INTO church_visitors(id,organization_id,campus_id,name,phone,email,neighborhood,origin_channel,stage,first_visit_date,notes,assigned_cell_id,assigned_leader_id)
    VALUES(?,?,?,?,?,?,?,?,'NEW',?,?,?,?)`,[id,org,campus,name,phone,body.email?.trim()||null,body.neighborhood?.trim()||null,origin,firstVisit,body.notes||null,cellId,leaderId]);
   if(evaluated.flags['intelligence.member_journey'])await trackNewWelcome(db,org,id,campus,user?.userId||null,firstVisit);
   await logSecurityEvent({organizationId:org,campusId:campus,user,action:'REGISTER_VISITOR',resource:'church_visitors',resourceId:id,
    details:{originChannel:origin,historicalDate:firstVisit!==dayInSaoPaulo()},event,strict:true,executor:(s,p)=>db.query(s,p)});
   await db.commit();return apiResponse(201,{id,stage:'NEW',journey_version:0,message:'Visitante cadastrado no acolhimento.'});
  }catch(error){await db.rollback();throw error;}finally{db.release();}
 }catch(error){return failure(error);}
}
