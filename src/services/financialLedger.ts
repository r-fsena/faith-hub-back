import {createHash} from 'crypto';
import {query,getConnection,apiResponse} from '../db';
import {requireAuth,enforceRole} from './authMiddleware';
import {intelligenceScope,IntelligenceScope,scopedWhere} from './intelligenceScope';
import {evaluateTenantFlags} from './featureFlagService';
import {IntelligenceError} from './intelligenceUsage';
import {dayInSaoPaulo,safeIdentifier} from './intelligenceModel';
import {requireDay,requireVersion} from './intelligenceJourneyModel';
import {checkRateLimit} from './rateLimiter';
import {logSecurityEvent} from './auditLogService';
export const LEDGER_ROLES=['SUPERADMIN','PASTOR','ADMIN','TREASURER'];
const METHODS=['PIX','CREDIT_CARD','DEBIT_CARD','BOLETO','CASH','TRANSFER'];
const MAX_CENTS=9_999_999_999;
export function cents(value:unknown,signed=false){if(typeof value!=='number'||!Number.isSafeInteger(value)||Math.abs(value)>MAX_CENTS||(!signed&&value<=0))throw new IntelligenceError(400,'Informe um valor válido em centavos.');return value;}
export function decimalCents(value:unknown){const text=String(value??'');if(!/^\d+(\.\d{1,2})?$/.test(text))throw new IntelligenceError(400,'Valor deve ter no máximo duas casas decimais.');const [whole,fraction='']=text.split('.');return cents(Number(whole)*100+Number(fraction.padEnd(2,'0')));}
const uuid=(value:unknown)=>{if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))throw new IntelligenceError(400,'Identificador da solicitação inválido.');return value;};
const hash=(value:any)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=(v:any,min:number,max:number)=>{if(typeof v!=='string'||v.trim().length<min||v.trim().length>max||/[\x00-\x1f]/.test(v))throw new IntelligenceError(400,'Confira os campos de texto.');return v.trim();};
const date=(value:any)=>{const d=requireDay(value);if(d>dayInSaoPaulo())throw new IntelligenceError(400,'A data efetiva não pode estar no futuro.');return d;};
const money=(n:number)=>(n/100).toFixed(2);
const executor=(db:any)=>(s:string,p?:any[])=>db.query(s,p);
async function audit(db:any,scope:IntelligenceScope,event:any,action:string,resource:string,id:string,details:any){await logSecurityEvent({organizationId:scope.organizationId,user:scope.user,action,resource,resourceId:id,details,event,strict:true,executor:executor(db)});}
async function transaction<T>(fn:(db:any)=>Promise<T>){const db=await getConnection();try{await db.beginTransaction();const result=await fn(db);await db.commit();return result;}catch(e){await db.rollback();throw e;}finally{db.release();}}
async function account(db:any,scope:IntelligenceScope,id:string,lock=false){if(!safeIdentifier(id))throw new IntelligenceError(400,'Conta inválida.');const f=scopedWhere(scope,'a');const [rows]=await db.query(`SELECT a.*,DATE_FORMAT(a.opening_on,'%Y-%m-%d') AS opening_on FROM church_financial_accounts a WHERE a.organization_id = ? AND a.id = ?${f.sql} LIMIT 1${lock?' FOR UPDATE':''}`,[scope.organizationId,id,...f.params]);if(!rows.length)throw new IntelligenceError(404,'Conta não encontrada no seu acesso.');const flags=(await evaluateTenantFlags(scope.organizationId,rows[0].campus_id,'production')).flags;if(!flags['financial.accounts_ledger']||!flags['financial.module_enabled']||!flags['financial.cashflow_ledger'])throw new IntelligenceError(403,'Esta fonte não está habilitada na unidade da conta.');return rows[0];}
async function posting(db:any,scope:IntelligenceScope,id:string,lock=false){if(!safeIdentifier(id))throw new IntelligenceError(400,'Lançamento inválido.');const f=scopedWhere(scope,'t');const [rows]=await db.query(`SELECT t.*,DATE_FORMAT(t.payment_date,'%Y-%m-%d') AS payment_date FROM church_financial_transactions t WHERE t.organization_id = ? AND t.id = ?${f.sql} LIMIT 1${lock?' FOR UPDATE':''}`,[scope.organizationId,id,...f.params]);if(!rows.length)throw new IntelligenceError(404,'Lançamento não encontrado no seu acesso.');return rows[0];}
async function paid(db:any,org:string,id:string){const [rows]=await db.query('SELECT COALESCE(SUM(amount_cents),0) AS paid FROM church_financial_settlements WHERE organization_id = ? AND transaction_id = ?',[org,id]);return Number(rows[0].paid);}
async function validCampus(db:any,org:string,id:string){if(!safeIdentifier(id)||id==='all')throw new IntelligenceError(400,'Escolha uma unidade.');const [rows]=await db.query('SELECT id FROM campuses WHERE organization_id = ? AND id = ?',[org,id]);if(!rows.length)throw new IntelligenceError(400,'Unidade não encontrada nesta igreja.');}

export async function createLedgerAccount(scope:IntelligenceScope,body:any,event:any){
 const id=uuid(body.request_id),name=text(body.name,2,80),opening=date(body.opening_on),balance=cents(body.opening_balance_cents,true),campus=scope.campusId;
 if(!campus)throw new IntelligenceError(400,'Escolha a unidade da conta.');
 return transaction(async db=>{await db.query('INSERT IGNORE INTO church_financial_ledger_rollout(organization_id,activated_at,activated_by) VALUES(?,UTC_TIMESTAMP(),?)',[scope.organizationId,scope.user.userId]);await validCampus(db,scope.organizationId,campus);const fingerprint=hash({org:scope.organizationId,campus,name,opening,balance});
 const [result]=await db.query(`INSERT IGNORE INTO church_financial_accounts(organization_id,id,campus_id,name,opening_on,opening_balance_cents,request_hash,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())`,[scope.organizationId,id,campus,name,opening,balance,fingerprint,scope.user.userId]);
 const row=await account(db,scope,id,true);if(row.request_hash!==fingerprint)throw new IntelligenceError(409,'A solicitação já foi usada com outros dados.');
 if(result.affectedRows)await audit(db,scope,event,'CREATE_FINANCIAL_ACCOUNT','church_financial_accounts',id,{campus_id:campus,opening_on:opening,opening_balance_cents:balance});
 return{id,created:!!result.affectedRows};});
}
export async function updateLedgerAccount(scope:IntelligenceScope,id:string,body:any,event:any){return transaction(async db=>{
 const a=await account(db,scope,id,true);if(requireVersion(body.expected_version)!==Number(a.version))throw new IntelligenceError(409,'A conta mudou. Atualize antes de salvar.');
 if(!['ACTIVE','INACTIVE'].includes(body.status))throw new IntelligenceError(400,'Situação inválida.');
 // Opening amount/date are immutable; an account archive never removes its balance/history.
 if(body.opening_on!==undefined||body.opening_balance_cents!==undefined||body.campus_id!==undefined&&body.campus_id!==a.campus_id)throw new IntelligenceError(400,'A abertura e a unidade da conta são preservadas.');
 const name=body.name===undefined?a.name:text(body.name,2,80);
 if(body.status==='INACTIVE'){
 const [pending]=await db.query(`SELECT COUNT(*) AS n FROM church_financial_transactions WHERE organization_id = ? AND account_id = ? AND ledger_version=1 AND status='PENDING'`,[scope.organizationId,id]);
 if(Number(pending[0].n))throw new IntelligenceError(409,'A conta possui lançamentos pendentes. Revise-os antes de arquivar.');}
 await db.query('UPDATE church_financial_accounts SET name=?,status=?,version=version+1,updated_at=UTC_TIMESTAMP() WHERE organization_id = ? AND id = ?',[name,body.status,scope.organizationId,id]);
 await audit(db,scope,event,'UPDATE_FINANCIAL_ACCOUNT','church_financial_accounts',id,{status:body.status});return{id,version:Number(a.version)+1};});}

export async function createLedgerPosting(scope:IntelligenceScope,body:any,event:any,adoptId?:string){
 const request=uuid(body.request_id);if(body.financial_kind&&body.financial_kind!=='OPERATING')throw new IntelligenceError(400,'Transferências e estornos usarão fluxos próprios.');
 return transaction(async db=>{
 const a=await account(db,scope,body.account_id,true);if(a.status!=='ACTIVE')throw new IntelligenceError(409,'A conta está arquivada.');
 const id=adoptId||request;let old:any=null;if(adoptId)old=await posting(db,scope,id,true);
 const fingerprint=hash({request,account:a.id,adopt:adoptId||null,type:adoptId?null:body.type,amount:adoptId?null:body.amount_cents,category:adoptId?null:body.category,description:adoptId?null:body.description,payment_method:adoptId?null:body.payment_method,payment_date:adoptId?null:body.payment_date});
 if(old&&Number(old.ledger_version)===1){if(old.ledger_request_hash!==fingerprint)throw new IntelligenceError(409,'Este lançamento já foi classificado por outra solicitação.');return{id,created:false};}
 if(old&&(old.status!=='PENDING'||(old.campus_id||'campus_sede')!==a.campus_id))throw new IntelligenceError(409,'Somente pendências da mesma unidade podem ser classificadas. Pagamentos antigos não recebem conta/data presumidas.');
 const type=old?.type||body.type;if(!['INCOME','EXPENSE'].includes(type))throw new IntelligenceError(400,'Tipo de movimento inválido.');
 const amount=old?decimalCents(old.amount):cents(body.amount_cents),category=old?.category||text(body.category,1,80),description=old?.description||text(body.description,2,255),method=old?.payment_method||body.payment_method||'PIX';
 if(!METHODS.includes(method))throw new IntelligenceError(400,'Meio de pagamento inválido.');
 const paymentDate=old?.payment_date||requireDay(body.payment_date||dayInSaoPaulo());
 if(!old){const [r]=await db.query(`INSERT IGNORE INTO church_financial_transactions(id,organization_id,campus_id,type,category,description,amount,payment_method,status,origin_module,payment_date,created_by,ledger_version,financial_kind,account_id,ledger_request_hash)
 VALUES(?,?,?,?,?,?,?,?,'PENDING','MANUAL',?,?,1,'OPERATING',?,?)`,[id,scope.organizationId,a.campus_id,type,category,description,money(amount),method,paymentDate,scope.user.userId,a.id,fingerprint]);
 const created=await posting(db,scope,id,true);if(created.ledger_request_hash!==fingerprint)throw new IntelligenceError(409,'A solicitação já foi usada com outros dados.');if(!r.affectedRows)return{id,created:false};
 }else await db.query(`UPDATE church_financial_transactions SET ledger_version=1,financial_kind='OPERATING',account_id=?,ledger_request_hash=?,ledger_lock_version=ledger_lock_version+1,updated_at=UTC_TIMESTAMP() WHERE organization_id = ? AND id = ?`,[a.id,fingerprint,scope.organizationId,id]);
 await audit(db,scope,event,old?'CLASSIFY_FINANCIAL_PENDING':'CREATE_LEDGER_POSTING','church_financial_transactions',id,{account_id:a.id,planned_cents:amount,financial_kind:'OPERATING',type});
 return{id,created:!old};});
}
export async function settleLedgerPosting(scope:IntelligenceScope,id:string,body:any,event:any){
 const request=uuid(body.request_id),amount=cents(body.amount_cents),settled=date(body.settled_on);
 return transaction(async db=>{
 const observed=await posting(db,scope,id);if(Number(observed.ledger_version)!==1||!observed.account_id)throw new IntelligenceError(409,'Classifique a pendência e sua conta antes de liquidar.');
 const a=await account(db,scope,observed.account_id,true),t=await posting(db,scope,id,true);if(t.account_id!==a.id||(t.campus_id||'campus_sede')!==a.campus_id)throw new IntelligenceError(409,'Conta e lançamento incompatíveis.');
 const fingerprint=hash({org:scope.organizationId,id,account:a.id,amount,settled});
 const [existing]=await db.query('SELECT transaction_id,request_hash FROM church_financial_settlements WHERE organization_id = ? AND id = ? FOR UPDATE',[scope.organizationId,request]);
 if(existing.length){if(existing[0].request_hash!==fingerprint)throw new IntelligenceError(409,'A solicitação já foi usada com outros dados.');return{id,settlement_id:request,recorded:false};}
 if(requireVersion(body.expected_version)!==Number(t.ledger_lock_version))throw new IntelligenceError(409,'O lançamento mudou. Atualize antes de liquidar.');
 if(t.status==='CANCELLED'||a.status!=='ACTIVE')throw new IntelligenceError(409,'Conta ou lançamento indisponível.');
 if(settled<a.opening_on)throw new IntelligenceError(400,'A liquidação não pode anteceder a abertura registrada da conta.');
 const nominal=decimalCents(t.amount),already=await paid(db,scope.organizationId,id);if(amount>nominal-already)throw new IntelligenceError(409,'O valor supera o saldo pendente.');
 await db.query(`INSERT INTO church_financial_settlements(organization_id,id,transaction_id,account_id,campus_id,amount_cents,settled_on,request_hash,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())`,[scope.organizationId,request,id,a.id,a.campus_id,amount,settled,fingerprint,scope.user.userId]);
 const status=already+amount===nominal?'PAID':'PENDING';
 await db.query(`UPDATE church_financial_transactions SET status=?,payment_date=IF(?='PAID',?,payment_date),ledger_lock_version=ledger_lock_version+1,updated_at=UTC_TIMESTAMP() WHERE organization_id = ? AND id = ?`,[status,status,settled,scope.organizationId,id]);
 if(t.type==='INCOME'&&t.project_id)await db.query('UPDATE church_special_projects SET collected_amount=collected_amount+? WHERE organization_id = ? AND id = ?',[money(amount),scope.organizationId,t.project_id]);
 await audit(db,scope,event,'RECORD_FINANCIAL_SETTLEMENT','church_financial_settlements',request,{transaction_id:id,account_id:a.id,amount_cents:amount,settled_on:settled,remaining_cents:nominal-already-amount});
 return{id,settlement_id:request,recorded:true,status,paid_cents:already+amount,remaining_cents:nominal-already-amount,version:Number(t.ledger_lock_version)+1};});
}
export async function cancelLedgerPosting(scope:IntelligenceScope,id:string,body:any,event:any){return transaction(async db=>{
 const observed=await posting(db,scope,id);if(observed.account_id)await account(db,scope,observed.account_id,true);const t=await posting(db,scope,id,true);
 if(Number(t.ledger_version)!==1)throw new IntelligenceError(409,'Este lançamento não pertence ao novo fluxo.');
 if(requireVersion(body.expected_version)!==Number(t.ledger_lock_version))throw new IntelligenceError(409,'O lançamento mudou. Atualize antes de salvar.');
 if(await paid(db,scope.organizationId,id)>0)throw new IntelligenceError(409,'Há liquidações registradas. Elas são preservadas; cancelamento não representa estorno.');
 const reason=text(body.reason,4,140);await db.query(`UPDATE church_financial_transactions SET status='CANCELLED',ledger_lock_version=ledger_lock_version+1,updated_at=UTC_TIMESTAMP() WHERE organization_id = ? AND id = ?`,[scope.organizationId,id]);
 await audit(db,scope,event,'CANCEL_UNSETTLED_LEDGER_POSTING','church_financial_transactions',id,{reason});return{id,cancelled:true,version:Number(t.ledger_lock_version)+1};});}

export async function ledgerOverview(scope:IntelligenceScope,page=0){
 if(!Number.isInteger(page)||page<0||page>100)throw new IntelligenceError(400,'Página inválida.');
 const cf=scopedWhere(scope,'c','id');const {rows:campuses}=await query(`SELECT c.id FROM campuses c WHERE c.organization_id = ?${cf.sql} LIMIT 201`,[scope.organizationId,...cf.params]);
 if(campuses.length>200)throw new IntelligenceError(400,'Selecione uma unidade.');const ids:string[]=[];
 for(const c of campuses){const f=(await evaluateTenantFlags(scope.organizationId,c.id,'production')).flags;if(f['financial.accounts_ledger']&&f['financial.module_enabled']&&f['financial.cashflow_ledger'])ids.push(c.id);}
 scope={...scope,campusIds:ids};const af=scopedWhere(scope,'a'),tf=scopedWhere(scope,'t');
 const {rows:accounts}=await query(`SELECT a.*,DATE_FORMAT(a.opening_on,'%Y-%m-%d') AS opening_on,
 a.opening_balance_cents+COALESCE((SELECT SUM(IF(t.type='INCOME',1,-1)*s.amount_cents) FROM church_financial_settlements s INNER JOIN church_financial_transactions t ON t.organization_id=s.organization_id AND t.id=s.transaction_id
 WHERE s.organization_id = ? AND s.account_id=a.id AND s.settled_on >= a.opening_on AND s.settled_on <= ?),0) AS balance_cents
 FROM church_financial_accounts a WHERE a.organization_id = ?${af.sql} ORDER BY a.status,a.name LIMIT 201`,[scope.organizationId,dayInSaoPaulo(),scope.organizationId,...af.params]);
 if(accounts.length>200)throw new IntelligenceError(400,'Selecione uma unidade para consultar as contas.');
 const {rows}=await query(`SELECT t.*,DATE_FORMAT(t.payment_date,'%Y-%m-%d') AS payment_date,ROUND(t.amount*100) AS planned_cents,
 COALESCE((SELECT SUM(s.amount_cents) FROM church_financial_settlements s WHERE s.organization_id = ? AND s.transaction_id=t.id),0) AS paid_cents,
 COALESCE(a.name,'Sem conta classificada') AS account_name
 FROM church_financial_transactions t LEFT JOIN church_financial_accounts a ON a.organization_id=t.organization_id AND a.id=t.account_id
 WHERE t.organization_id = ? AND (t.ledger_version=1 OR t.status='PENDING')${tf.sql} ORDER BY t.created_at DESC,t.id DESC LIMIT 51 OFFSET ?`,[scope.organizationId,scope.organizationId,...tf.params,page*50]);
 return{accounts:accounts.map(a=>({id:a.id,campus_id:a.campus_id,name:a.name,currency:a.currency,opening_on:a.opening_on,opening_balance_cents:Number(a.opening_balance_cents),balance_cents:Number(a.balance_cents),status:a.status,version:Number(a.version)})),
 postings:rows.slice(0,50).map(t=>({id:t.id,campus_id:t.campus_id||'campus_sede',type:t.type,category:t.category,description:t.description,payment_method:t.payment_method,status:t.status,payment_date:t.payment_date,ledger_version:Number(t.ledger_version),financial_kind:t.financial_kind,account_id:t.account_id,account_name:t.account_name,
  planned_cents:Number(t.planned_cents),paid_cents:Number(t.paid_cents),remaining_cents:Number(t.planned_cents)-Number(t.paid_cents),version:Number(t.ledger_lock_version)})),has_more:rows.length>50,page,
 notes:['Saldo é a abertura declarada mais as liquidações registradas, sem conciliação bancária automática. Contas arquivadas conservam seu histórico.',
  'O valor previsto é separado do liquidado. Liquidações parciais entram nos indicadores pela própria data efetiva, sem somar novamente o valor nominal.',
  'Registros antigos não recebem conta ou data presumidas. Classifique somente pendências verificáveis.',
  'Registrar uma liquidação documenta o fato; não executa transferência, pagamento ou reembolso no banco/provedor.']};
}
export async function ledgerSettlements(scope:IntelligenceScope,id:string){
 const db=await getConnection();try{
 const t=await posting(db,scope,id);if(!t.account_id)throw new IntelligenceError(409,'Este registro ainda não tem conta classificada.');await account(db,scope,t.account_id);
 const [rows]:any=await db.query("SELECT id,amount_cents,DATE_FORMAT(settled_on,'%Y-%m-%d') AS settled_on,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.000Z') AS recorded_at FROM church_financial_settlements WHERE organization_id = ? AND transaction_id = ? ORDER BY settled_on DESC,created_at DESC LIMIT 501",[scope.organizationId,id]);
 return{settlements:rows.slice(0,500).map((s:any)=>({...s,amount_cents:Number(s.amount_cents)})),truncated:rows.length>500};
 }finally{db.release();}
}
export async function financialLedgerHandler(event:any){
 try{const auth=await requireAuth(event);if('errorResponse'in auth)return auth.errorResponse;const role=enforceRole(auth.user,LEDGER_ROLES);if(!role.allowed)return role.errorResponse!;
 if((event.body||'').length>32768)return apiResponse(413,{message:'Solicitação muito grande.'});const body=event.body?JSON.parse(event.body):{};if(!body||typeof body!=='object'||Array.isArray(body))throw new IntelligenceError(400,'Envie um objeto JSON.');
 const scope=await intelligenceScope(event,auth.user,body);if('statusCode'in scope)return scope;
 const rate=await checkRateLimit(event,{maxRequests:60,windowSeconds:60,identifierPrefix:'financial-ledger:'+scope.organizationId+':'+scope.user.userId});if(!rate.allowed)return rate.errorResponse!;
 const flags=(await evaluateTenantFlags(scope.organizationId,scope.campusId,'production')).flags;if(!flags['financial.accounts_ledger']||!flags['financial.module_enabled']||!flags['financial.cashflow_ledger'])throw new IntelligenceError(403,'Contas e liquidações não estão habilitadas neste acesso.');
 const path=((event as any).rawPath||event.path||'').split('/').filter(Boolean),route=path.slice(path.indexOf('ledger')+1),method=event.requestContext?.http?.method||event.httpMethod;
 let result:any;
 if(method==='GET'&&!route.length)result=await ledgerOverview(scope,Number(event.queryStringParameters?.page||0));
 else if(method==='GET'&&route.length===3&&route[0]==='postings'&&route[2]==='settlements')result=await ledgerSettlements(scope,route[1]);
 else if(method==='POST'&&route[0]==='accounts'&&route.length===1)result=await createLedgerAccount(scope,body,event);
 else if(method==='PATCH'&&route[0]==='accounts'&&route.length===2)result=await updateLedgerAccount(scope,route[1],body,event);
 else if(method==='POST'&&route[0]==='postings'&&route.length===1)result=await createLedgerPosting(scope,body,event);
 else if(method==='POST'&&route[0]==='postings'&&route.length===3&&route[1]&&route[2]==='adopt')result=await createLedgerPosting(scope,body,event,route[1]);
 else if(method==='POST'&&route[0]==='postings'&&route.length===3&&route[1]&&route[2]==='settlements')result=await settleLedgerPosting(scope,route[1],body,event);
 else if(method==='POST'&&route[0]==='postings'&&route.length===3&&route[1]&&route[2]==='cancel')result=await cancelLedgerPosting(scope,route[1],body,event);
 else return apiResponse(404,{message:'Recurso não encontrado.'});
 return apiResponse(200,result,{'Cache-Control':'no-store'});
 }catch(e){if(e instanceof IntelligenceError)return apiResponse(e.status,{message:e.message});if(e instanceof SyntaxError)return apiResponse(400,{message:'JSON inválido.'});console.error('Financial ledger unavailable',{name:(e as Error).name});return apiResponse(503,{message:'Não foi possível concluir a operação financeira. Atualize e tente novamente.'});}
}

/** Old clients share the same lock as adoption/settlement: no check-then-delete race. */
export async function legacyFinancialMutation(event:any,mode:'update'|'delete'){
 try{const auth=await requireAuth(event);if('errorResponse'in auth)return auth.errorResponse;const role=enforceRole(auth.user,LEDGER_ROLES);if(!role.allowed)return role.errorResponse!;
 const body=event.body?JSON.parse(event.body):{},scope=await intelligenceScope(event,auth.user,body);if('statusCode'in scope)return scope;
 const id=event.pathParameters?.id;if(!safeIdentifier(id))throw new IntelligenceError(400,'Lançamento inválido.');
 const result=await transaction(async db=>{
 const t=await posting(db,scope,id,true),flags=(await evaluateTenantFlags(scope.organizationId,t.campus_id||'campus_sede','production')).flags;
 const [rollout]=await db.query('SELECT organization_id FROM church_financial_ledger_rollout WHERE organization_id = ?',[scope.organizationId]);
 const protectedOrg=rollout.length>0||flags['financial.accounts_ledger'];
 if(Number(t.ledger_version)>0||(protectedOrg&&(t.status==='PAID'||body.status==='PAID')))throw new IntelligenceError(409,'O registro é protegido. Use contas e liquidações; alteração/exclusão não representa estorno.');
 if(mode==='delete'){
 await db.query('DELETE FROM church_financial_transactions WHERE organization_id = ? AND id = ?',[scope.organizationId,id]);
 await audit(db,scope,event,'DELETE_UNSETTLED_LEGACY_TRANSACTION','church_financial_transactions',id,{});return{id,deleted:true};}
 const amount=body.amount===undefined?t.amount:money(decimalCents(body.amount)),type=body.type||t.type,status=body.status||t.status,method=body.payment_method||t.payment_method;
 if(!['INCOME','EXPENSE'].includes(type)||!['PAID','PENDING','CANCELLED'].includes(status)||!METHODS.includes(method))throw new IntelligenceError(400,'Campos financeiros inválidos.');
 if(body.project_id){const [projects]=await db.query("SELECT id FROM church_special_projects WHERE organization_id = ? AND id = ? AND (campus_id IS NULL OR campus_id = ?)",[scope.organizationId,body.project_id,t.campus_id||'campus_sede']);if(!projects.length)throw new IntelligenceError(400,'Projeto não encontrado no seu escopo.');}
 await db.query(`UPDATE church_financial_transactions SET type=?,category=?,description=?,amount=?,payment_method=?,status=?,member_name=?,project_id=?,receipt_url=?,payment_date=?,updated_at=UTC_TIMESTAMP() WHERE organization_id = ? AND id = ?`,[
 type,body.category===undefined?t.category:text(body.category,1,80),body.description===undefined?t.description:text(body.description,2,255),amount,method,status,
 body.member_name===undefined?t.member_name:body.member_name,body.project_id===undefined?t.project_id:body.project_id,body.receipt_url===undefined?t.receipt_url:body.receipt_url,
 body.payment_date===undefined?t.payment_date:requireDay(body.payment_date),scope.organizationId,id]);
 await audit(db,scope,event,'UPDATE_LEGACY_FINANCIAL_TRANSACTION','church_financial_transactions',id,{type,status});return{id,updated:true};
 });return apiResponse(200,result,{'Cache-Control':'no-store'});
 }catch(e){if(e instanceof IntelligenceError)return apiResponse(e.status,{error:'FINANCIAL_WRITE_REJECTED',message:e.message});if(e instanceof SyntaxError)return apiResponse(400,{message:'JSON inválido.'});console.error('Legacy financial mutation failed',{name:(e as Error).name});return apiResponse(503,{message:'Não foi possível concluir a alteração financeira.'});}
}
