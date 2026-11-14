import {randomUUID,createHash} from 'crypto';
import {query,getConnection,apiResponse} from '../db';
import {AuthUser,requireAuth,enforceRole,normalizeRole} from './authMiddleware';
import {IntelligenceScope,intelligenceScope,scopedWhere} from './intelligenceScope';
import {evaluateTenantFlags} from './featureFlagService';
import {intelligencePeriod,IntelligencePeriod,safeIdentifier} from './intelligenceModel';
import {IntelligenceError} from './intelligenceUsage';
import {logSecurityEvent} from './auditLogService';
import {checkRateLimit} from './rateLimiter';
import {REPORT_VERSION,REPORT_MODELS,ReportModel,collectReportData} from './intelligenceReportData';
import {reportPdf,reportCsv} from './intelligenceReportFiles';
import {reportsConfigured,enqueueReport,saveReportFile,readReportFile,removeReportFile} from './intelligenceReportStorage';
const REPORT_FIELDS="*,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.000Z') AS created_at,DATE_FORMAT(updated_at,'%Y-%m-%dT%H:%i:%s.000Z') AS updated_at,DATE_FORMAT(expires_at,'%Y-%m-%dT%H:%i:%s.000Z') AS expires_at,(expires_at<=UTC_TIMESTAMP()) AS is_expired";
const ROLES=['SUPERADMIN','PASTOR','ADMIN','TREASURER','LEADER'];
const REQUIRED:Record<ReportModel,string[]>={executive:['intelligence.reports','intelligence.overview'],financial:['intelligence.reports','intelligence.finance','financial.module_enabled','financial.cashflow_ledger'],operations:['intelligence.reports','intelligence.operations'],community:['intelligence.reports','intelligence.member_journey','visitors.module_enabled']};
const SOURCE_FEATURES=['intelligence.usage_collection','members.module_enabled','cell_groups.module_enabled','visitors.module_enabled','events.module_enabled','pdv.module_enabled','pdv.stock_inventory','ministries.module_enabled','volunteers.module_enabled','kids.module_enabled','kids.reports_export','intelligence.activation','intelligence.member_journey','intelligence.history','intelligence.finance','intelligence.operations','financial.module_enabled','financial.cashflow_ledger','content.analytics_dashboard','devotionals.module_enabled','studies.module_enabled','broadcasts.module_enabled','intelligence.calendar','intelligence.capacities'];
const digest=(v:any)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const parse=<T>(v:any):T=>typeof v==='string'?JSON.parse(v):v;
const validId=(v:any)=>{if(typeof v!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v))throw new IntelligenceError(400,'Referência de relatório inválida.');return v;};
function modelAllowed(user:AuthUser,model:ReportModel){if(!Object.hasOwn(REPORT_MODELS,model))throw new IntelligenceError(400,'Modelo de relatório inválido.');if(user.role==='TREASURER'&&model!=='financial'||user.role==='LEADER'&&['financial','operations'].includes(model))throw new IntelligenceError(403,'Este modelo não está disponível no seu perfil.');}
async function captureScope(scope:IntelligenceScope,model:ReportModel){
 const f=scopedWhere(scope,'c','id');const {rows}=await query(`SELECT c.id FROM campuses c WHERE c.organization_id = ?${f.sql} ORDER BY c.id LIMIT 201`,[scope.organizationId,...f.params]);
 if(!rows.length||rows.length>200)throw new IntelligenceError(400,'Selecione de 1 a 200 unidades autorizadas.');
 const access:Array<{campus:string;features:string[]}>=[];
 for(const row of rows){const flags=(await evaluateTenantFlags(scope.organizationId,row.id,'production')).flags;if(!REQUIRED[model].every(k=>flags[k]))throw new IntelligenceError(403,'O modelo não está habilitado em todas as unidades selecionadas. Restrinja o escopo.');access.push({campus:row.id,features:[...new Set([...REQUIRED[model],...SOURCE_FEATURES.filter(k=>flags[k])])]});}
 return{scope:{campusId:scope.campusId,campusIds:rows.map(r=>r.id),cellIds:scope.cellIds},access};
}
async function reportFlags(scope:IntelligenceScope,access:Array<{campus:string;features:string[]}>){
 const maximum=Object.fromEntries(access.map(a=>[a.campus,a.features]));const flags={...(await evaluateTenantFlags(scope.organizationId,scope.campusId,'production')).flags};
 for(const key of SOURCE_FEATURES)if(!access.every(a=>a.features.includes(key)))flags[key]=false;
 for(let i=0;i<access.length;i+=4){const batch=await Promise.all(access.slice(i,i+4).map(a=>evaluateTenantFlags(scope.organizationId,a.campus,'production')));for(const current of batch)for(const key of SOURCE_FEATURES)if(!current.flags[key])flags[key]=false;}
 return{flags,maximum};
}
async function currentRequester(job:any):Promise<AuthUser>{
 const {rows}=await query('SELECT id,name,email,role,status,organization_id,campus_id,campus_ids,operational_permissions FROM members WHERE organization_id = ? AND id = ? LIMIT 1',[job.requester_organization_id,job.requested_by]);
 if(rows.length!==1||!['ACTIVE','ATIVO'].includes(String(rows[0].status).toUpperCase()))throw new IntelligenceError(403,'O solicitante não possui acesso ativo.');
 const m=rows[0],role=normalizeRole(m.role),campusIds=parse<any>(m.campus_ids||'null'),permissions=parse<any>(m.operational_permissions||'[]');
 return{userId:m.id,email:m.email,name:m.name,role,organizationId:m.organization_id,campusIds:Array.isArray(campusIds)&&campusIds.length?campusIds:[m.campus_id||'campus_sede'],operationalPermissions:Array.isArray(permissions)?permissions:[],isSuperAdmin:role==='SUPERADMIN'};
}
export async function authorizeReport(job:any,user?:AuthUser):Promise<IntelligenceScope>{
 const actor=user||await currentRequester(job);modelAllowed(actor,job.model);
 if(actor.userId!==job.requested_by||actor.organizationId!==job.requester_organization_id)throw new IntelligenceError(403,'O relatório pertence a outro solicitante.');
 const selected=parse<any>(job.scope_json),event={headers:{'x-organization-id':job.organization_id},queryStringParameters:{campus_id:selected.campusId||'all'}};
 const current=await intelligenceScope(event,actor);if('statusCode'in current)throw new IntelligenceError(403,'O acesso ao escopo foi alterado.');
 const f=scopedWhere(current,'c','id'),{rows}=await query(`SELECT c.id FROM campuses c WHERE c.organization_id = ?${f.sql}`,[job.organization_id,...f.params]);
 if(!selected.campusIds.every((id:string)=>rows.some(r=>r.id===id))||selected.cellIds!==null&&current.cellIds!==null&&!selected.cellIds.every((id:string)=>current.cellIds.includes(id)))throw new IntelligenceError(403,'O acesso às unidades ou grupos foi alterado.');
 if(selected.cellIds===null&&current.cellIds!==null)throw new IntelligenceError(403,'O perfil atual não permite o escopo consolidado.');
 for(const saved of parse<any[]>(job.access_json)){const flags=(await evaluateTenantFlags(job.organization_id,saved.campus,'production')).flags;if(!saved.features.every((key:string)=>flags[key]))throw new IntelligenceError(403,'Uma fonte do relatório deixou de estar habilitada.');}
 return{...current,campusIds:selected.campusIds,cellIds:selected.cellIds};
}
async function ownReport(scope:IntelligenceScope,id:string){validId(id);const {rows}=await query(`SELECT ${REPORT_FIELDS} FROM intelligence_reports WHERE organization_id = ? AND id = ? AND requested_by = ? AND requester_organization_id = ?`,[scope.organizationId,id,scope.user.userId,scope.user.organizationId]);if(!rows.length)throw new IntelligenceError(404,'Relatório não encontrado neste acesso.');return rows[0];}
const publicReport=(job:any)=>({id:job.id,model:job.model,title:REPORT_MODELS[job.model as ReportModel],status:job.status,period:parse<IntelligencePeriod>(job.period_json),created_at:job.created_at,updated_at:job.updated_at,expires_at:job.expires_at,definition_version:job.definition_version,error_code:job.error_code,preview:job.result_json?parse<any>(job.result_json).preview:null});
export async function dispatchPendingReports(org:string){
 await query("UPDATE intelligence_reports SET status='EXPIRED',error_code='EXPIRED',updated_at=UTC_TIMESTAMP(6) WHERE organization_id = ? AND expires_at<=UTC_TIMESTAMP() AND status IN ('QUEUED','GENERATING','READY','READY_WITH_NOTES')",[org]);
 if(!reportsConfigured())return;
 const {rows}=await query("SELECT id FROM intelligence_reports WHERE organization_id = ? AND delivery_state='PENDING' AND status='QUEUED' AND expires_at>UTC_TIMESTAMP() ORDER BY created_at LIMIT 20",[org]);
 for(const row of rows){await enqueueReport(org,row.id);await query("UPDATE intelligence_reports SET delivery_state='SENT',updated_at=UTC_TIMESTAMP(6) WHERE organization_id = ? AND id = ? AND delivery_state='PENDING'",[org,row.id]);}
}
export async function createReport(scope:IntelligenceScope,body:any,event:any){
 if(!reportsConfigured())throw new IntelligenceError(503,'A geração de relatórios aguarda a liberação da infraestrutura deste ambiente.');
 const id=validId(body.request_id),model=body.model as ReportModel;modelAllowed(scope.user,model);
 const period=intelligencePeriod(body.period||'month');if(body.expected_period&&body.expected_period!==digest(period))throw new IntelligenceError(409,'O período mudou. Confira novamente a prévia.');
 const captured=await captureScope(scope,model),fingerprint=digest({model,period,scope:captured.scope,owner:scope.user.userId,home:scope.user.organizationId});
 const db=await getConnection();try{await db.beginTransaction();const [r]:any=await db.query(`INSERT IGNORE INTO intelligence_reports(organization_id,id,campus_id,requested_by,requester_organization_id,model,period_json,scope_json,access_json,request_hash,definition_version,contains_digital,created_at,updated_at,expires_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6),DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 DAY))`,[scope.organizationId,id,scope.campusId,scope.user.userId,scope.user.organizationId,model,JSON.stringify(period),JSON.stringify(captured.scope),JSON.stringify(captured.access),fingerprint,REPORT_VERSION,model==='executive'?1:0]);
 const [existing]:any=await db.query('SELECT request_hash FROM intelligence_reports WHERE organization_id = ? AND id = ? FOR UPDATE',[scope.organizationId,id]);if(existing[0]?.request_hash!==fingerprint)throw new IntelligenceError(409,'A solicitação já foi usada com outros dados.');
 if(r.affectedRows)await logSecurityEvent({organizationId:scope.organizationId,user:scope.user,action:'REQUEST_INTELLIGENCE_REPORT',resource:'intelligence_reports',resourceId:id,details:{model,period,scope:captured.scope},event,strict:true,executor:(s,p)=>db.query(s,p)});await db.commit();
 }catch(e){await db.rollback();throw e;}finally{db.release();}
 try{await dispatchPendingReports(scope.organizationId);}catch{console.warn('Report delivery awaiting retry',{organizationId:scope.organizationId});}
 return publicReport(await ownReport(scope,id));
}
export async function processReport(message:any){
 if(message?.type!=='INTELLIGENCE_REPORT_V1'||!safeIdentifier(message.organization_id))throw Error('INVALID_REPORT_MESSAGE');
 const org=message.organization_id,id=validId(message.report_id),token=randomUUID();
 const {rows}=await query('SELECT * FROM intelligence_reports WHERE organization_id = ? AND id = ?',[org,id]);if(!rows.length)return;
 const job=rows[0];if(['READY','READY_WITH_NOTES','CANCELLED','EXPIRED','ACCESS_REVOKED','FAILED'].includes(job.status))return;
 const claim:any=await query(`UPDATE intelligence_reports SET status='GENERATING',attempts=attempts+1,lease_token=?,lease_until=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 180 SECOND),updated_at=UTC_TIMESTAMP(6)
 WHERE organization_id = ? AND id = ? AND attempts<3 AND expires_at>UTC_TIMESTAMP() AND (status='QUEUED' OR (status='GENERATING' AND lease_until<UTC_TIMESTAMP()))`,[token,org,id]);
 if(!claim.rows.affectedRows){await query("UPDATE intelligence_reports SET status='FAILED',error_code='RETRIES_EXHAUSTED',updated_at=UTC_TIMESTAMP(6) WHERE organization_id = ? AND id = ? AND attempts>=3 AND status IN ('QUEUED','GENERATING') AND (lease_until IS NULL OR lease_until<UTC_TIMESTAMP())",[org,id]);return;}
 const keys:string[]=[];
 try{
  const scope=await authorizeReport(job),evaluated=await reportFlags(scope,parse(job.access_json));
  const {rows:organizations}=await query('SELECT name FROM organizations WHERE id = ?',[org]);
  const data=await collectReportData(scope,evaluated.flags,job.model,parse<IntelligencePeriod>(job.period_json),organizations[0]?.name||'Organização',evaluated.maximum);
  const files={pdf:await reportPdf(data),csv:reportCsv(data)};const objects:Record<string,string>={},hashes:Record<string,string>={};
  for(const [format,bytes]of Object.entries(files)){const key=`reports/${org}/${id}/${token}/report.${format}`;keys.push(key);await saveReportFile(key,bytes,format==='pdf'?'application/pdf':'text/csv; charset=utf-8');objects[format]=key;hashes[format]=createHash('sha256').update(bytes).digest('hex');}
  // Permissions/privacy may change while rendering; verify again before publishing either file.
  await authorizeReport(job);
  const preview={...data,rows:data.rows.slice(0,50),total_rows:data.rows.length};
  const db=await getConnection();let published=false;
  try{await db.beginTransaction();const [result]:any=await db.query("UPDATE intelligence_reports SET status=?,result_json=?,lease_until=NULL,error_code=NULL,updated_at=UTC_TIMESTAMP(6) WHERE organization_id = ? AND id = ? AND status='GENERATING' AND lease_token=?",[data.rows.some(r=>r.current===null||r.status==='error')?'READY_WITH_NOTES':'READY',JSON.stringify({objects,hashes,revision:data.revision,preview}),org,id,token]);
   if(result.affectedRows){await logSecurityEvent({organizationId:org,user:scope.user,action:'GENERATE_INTELLIGENCE_REPORT',resource:'intelligence_reports',resourceId:id,details:{model:job.model,revision:data.revision,rows:data.rows.length},strict:true,executor:(sql,p)=>db.query(sql,p)});published=true;}await db.commit();
  }catch(error){await db.rollback();throw error;}finally{db.release();}
  if(!published)for(const key of keys)await removeReportFile(key);
 }catch(e){
  for(const key of keys)try{await removeReportFile(key);}catch{console.warn('Private report cleanup deferred to lifecycle',{organizationId:org,reportId:id});}
  const exhausted=Number(job.attempts)+1>=3;
  const denied=e instanceof IntelligenceError&&[401,403].includes(e.status),limit=e instanceof IntelligenceError&&[400,413].includes(e.status);
  await query("UPDATE intelligence_reports SET status=?,error_code=?,lease_until=NULL,updated_at=UTC_TIMESTAMP(6) WHERE organization_id = ? AND id = ? AND status='GENERATING' AND lease_token=?",[denied?'ACCESS_REVOKED':limit||exhausted?'FAILED':'QUEUED',denied?'ACCESS_CHANGED':limit?'REDUCE_SCOPE':exhausted?'RETRIES_EXHAUSTED':'SOURCE_UNAVAILABLE',org,id,token]);
  if(!denied&&!limit&&!exhausted)throw Error('REPORT_SOURCE_UNAVAILABLE');
 }
}
export async function intelligenceReportsHandler(event:any){
 try{
  const auth=await requireAuth(event);if('errorResponse'in auth)return auth.errorResponse;const role=enforceRole(auth.user,ROLES);if(!role.allowed)return role.errorResponse!;
  if((event.body||'').length>16384)throw new IntelligenceError(413,'Solicitação muito grande.');const body=JSON.parse(event.body||'{}');if(!body||Array.isArray(body)||typeof body!=='object')throw new IntelligenceError(400,'Envie um objeto JSON.');
  const scope=await intelligenceScope(event,auth.user,body);if('statusCode'in scope)return scope;
  const flags=(await evaluateTenantFlags(scope.organizationId,scope.campusId,'production')).flags;if(!flags['intelligence.reports']||!flags['intelligence.overview'])throw new IntelligenceError(403,'Relatórios não estão habilitados neste acesso.');
  const rate=await checkRateLimit(event,{maxRequests:20,windowSeconds:60,identifierPrefix:'intelligence-reports:'+scope.organizationId+':'+auth.user.userId});if(!rate.allowed)return rate.errorResponse!;
  const path=(event.rawPath||event.path||'').split('/').filter(Boolean),route=path.slice(path.indexOf('reports')+1),method=event.requestContext?.http?.method||event.httpMethod;
  let result:any;
  if(method==='GET'&&route[0]==='options')result={models:Object.entries(REPORT_MODELS).filter(([m])=>{try{modelAllowed(auth.user,m as ReportModel);return REQUIRED[m as ReportModel].every(k=>flags[k]);}catch{return false;}}).map(([id,title])=>({id,title})),limits:{rows:20000,bytes_per_file:3*1024*1024,retention_days:30}};
  else if(method==='POST'&&route[0]==='preview'){
   const model=body.model as ReportModel;modelAllowed(auth.user,model);const captured=await captureScope(scope,model),period=intelligencePeriod(body.period||'month');
   const {rows}=await query('SELECT name FROM organizations WHERE id = ?',[scope.organizationId]);const evaluated=await reportFlags(scope,captured.access);const data=await collectReportData({...scope,...captured.scope},evaluated.flags,model,period,rows[0]?.name||'Organização',evaluated.maximum);result={...data,rows:data.rows.slice(0,50),total_rows:data.rows.length,period_signature:digest(period)};
  }else if(method==='POST'&&!route.length)result=await createReport(scope,body,event);
  else if(method==='GET'&&!route.length){const page=Number(event.queryStringParameters?.page||0);if(!Number.isInteger(page)||page<0||page>100)throw new IntelligenceError(400,'Página inválida.');const {rows}=await query(`SELECT ${REPORT_FIELDS} FROM intelligence_reports WHERE organization_id = ? AND requested_by = ? AND requester_organization_id = ? AND campus_id <=> ? ORDER BY created_at DESC LIMIT 21 OFFSET ?`,[scope.organizationId,auth.user.userId,auth.user.organizationId,scope.campusId,page*20]);const reports=[];for(const job of rows.slice(0,20)){try{await authorizeReport(job,auth.user);reports.push(publicReport(job));}catch{reports.push({...publicReport(job),status:'ACCESS_REVOKED',preview:null,error_code:'ACCESS_CHANGED'});}}result={reports,page,has_more:rows.length>20};
  }else if(route[0]){
   const job=await ownReport(scope,route[0]);await authorizeReport(job,auth.user);
   if(method==='POST'&&route[1]==='cancel'&&route.length===2){
    const db=await getConnection();try{await db.beginTransaction();await db.query("UPDATE intelligence_reports SET status='CANCELLED',updated_at=UTC_TIMESTAMP(6) WHERE organization_id = ? AND id = ? AND status IN ('QUEUED','GENERATING')",[scope.organizationId,job.id]);await logSecurityEvent({organizationId:scope.organizationId,user:auth.user,action:'CANCEL_INTELLIGENCE_REPORT',resource:'intelligence_reports',resourceId:job.id,event,strict:true,executor:(s,p)=>db.query(s,p)});await db.commit();}catch(e){await db.rollback();throw e;}finally{db.release();}result=publicReport(await ownReport(scope,job.id));
   }else if(method==='GET'&&route[1]==='download'&&route.length===2){
    const format=event.queryStringParameters?.format;if(!['pdf','csv'].includes(format))throw new IntelligenceError(400,'Escolha PDF ou CSV.');
    if(Number(job.is_expired)||job.status==='EXPIRED')throw new IntelligenceError(410,'O arquivo expirou. Gere uma nova revisão.');
    if(!['READY','READY_WITH_NOTES'].includes(job.status))throw new IntelligenceError(409,'O arquivo não está disponível para download.');
    const key=parse<any>(job.result_json).objects[format],prefix=`reports/${scope.organizationId}/${job.id}/`;if(typeof key!=='string'||!key.startsWith(prefix)||key.includes('..'))throw new IntelligenceError(403,'Arquivo fora do escopo.');
    const bytes=await readReportFile(key);if(createHash('sha256').update(bytes).digest('hex')!==parse<any>(job.result_json).hashes?.[format])throw new IntelligenceError(409,'A integridade do arquivo não foi confirmada. Gere uma nova versão.');const latest=await ownReport(scope,job.id);if(Number(latest.is_expired))throw new IntelligenceError(410,'O arquivo expirou. Gere uma nova revisão.');if(!['READY','READY_WITH_NOTES'].includes(latest.status)||latest.lease_token!==job.lease_token)throw new IntelligenceError(403,'O acesso ao arquivo foi revogado.');await authorizeReport(latest,auth.user);
    await logSecurityEvent({organizationId:scope.organizationId,user:auth.user,action:'DOWNLOAD_INTELLIGENCE_REPORT',resource:'intelligence_reports',resourceId:job.id,details:{format,revision:parse<any>(job.result_json).revision},event,strict:true});
    const base=apiResponse(200,{}, {'Content-Type':format==='pdf'?'application/pdf':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${job.model}-${job.id}.${format}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});return {...base,body:bytes.toString('base64'),isBase64Encoded:true};
   }else if(method==='GET'&&route.length===1)result=publicReport(job);else return apiResponse(404,{message:'Recurso não encontrado.'});
  }else return apiResponse(404,{message:'Recurso não encontrado.'});
  return apiResponse(method==='POST'&&!route.length?202:200,result,{'Cache-Control':'no-store'});
 }catch(e){if(e instanceof IntelligenceError)return apiResponse(e.status,{message:e.message});if(e instanceof SyntaxError)return apiResponse(400,{message:'JSON inválido.'});console.error('Report request unavailable',{name:(e as Error).name});return apiResponse(503,{message:'Não foi possível consultar ou gerar o relatório. Tente novamente.'});}
}
