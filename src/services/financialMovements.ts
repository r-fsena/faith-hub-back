import {query,apiResponse} from '../db';
import {requireAuth,enforceRole} from './authMiddleware';
import {intelligenceScope,IntelligenceScope,scopedWhere} from './intelligenceScope';
import {evaluateTenantFlags} from './featureFlagService';
import {IntelligenceError} from './intelligenceUsage';
import {requireVersion} from './intelligenceJourneyModel';
import {checkRateLimit} from './rateLimiter';
import {LEDGER_ROLES,uuid,cents,decimalCents,text,date,hash,transaction,account,posting,paid,audit,money} from './financialLedger';

async function enabled(scope:IntelligenceScope,campus:string|null) {
 const flags=(await evaluateTenantFlags(scope.organizationId,campus,'production')).flags;
 if(!flags['financial.transfers_reversals']||!flags['financial.accounts_ledger']||!flags['financial.module_enabled']||!flags['financial.cashflow_ledger'])
  throw new IntelligenceError(403,'Transferências e revisões financeiras não estão habilitadas neste acesso.');
}
async function existing(db:any,org:string,id:string,fingerprint:string) {
 const [rows]=await db.query('SELECT request_hash FROM church_financial_operations WHERE organization_id = ? AND id = ? FOR UPDATE',[org,id]);
 if(!rows.length)return false;
 if(rows[0].request_hash!==fingerprint)throw new IntelligenceError(409,'A solicitação já foi usada com outros dados.');
 return true;
}

export async function transferAccounts(scope:IntelligenceScope,body:any,event:any) {
 const id=uuid(body.request_id),amount=cents(body.amount_cents),on=date(body.occurred_on),reason=text(body.reason,8,240);
 if(body.from_account_id===body.to_account_id)throw new IntelligenceError(400,'Escolha duas contas diferentes.');
 const fingerprint=hash({kind:'TRANSFER',from:body.from_account_id,to:body.to_account_id,amount,on,reason,actor:scope.user.userId});
 return transaction(async db=>{
  // All writers lock accounts before postings; opposing transfers use the same lock order.
  const ids=[body.from_account_id,body.to_account_id].sort(),accounts=new Map<string,any>();
  for(const key of ids){const a=await account(db,scope,key,true);await enabled(scope,a.campus_id);accounts.set(key,a);}
  if(await existing(db,scope.organizationId,id,fingerprint))return{id,recorded:false};
  const from=accounts.get(body.from_account_id),to=accounts.get(body.to_account_id);
  if(from.status!=='ACTIVE'||to.status!=='ACTIVE')throw new IntelligenceError(409,'As duas contas precisam estar ativas.');
  if(requireVersion(body.expected_from_version)!==Number(from.version)||requireVersion(body.expected_to_version)!==Number(to.version))throw new IntelligenceError(409,'Uma conta mudou. Atualize antes de registrar.');
  if(on<from.opening_on||on<to.opening_on)throw new IntelligenceError(400,'A transferência não pode anteceder a abertura das contas.');
  await db.query(`INSERT INTO church_financial_operations(organization_id,id,kind,amount_cents,occurred_on,reason,request_hash,created_by,created_at)
   VALUES(?,?,'TRANSFER',?,?,?,?,?,UTC_TIMESTAMP(6))`,[scope.organizationId,id,amount,on,reason,fingerprint,scope.user.userId]);
  for(const [leg,a,value]of [[0,from,-amount],[1,to,amount]] as const){
   await db.query(`INSERT INTO church_financial_cash_movements(organization_id,operation_id,leg,account_id,campus_id,amount_cents,occurred_on) VALUES(?,?,?,?,?,?,?)`,[scope.organizationId,id,leg,a.id,a.campus_id,value,on]);
   await db.query('UPDATE church_financial_accounts SET version=version+1,updated_at=UTC_TIMESTAMP() WHERE organization_id = ? AND id = ?',[scope.organizationId,a.id]);
  }
  await audit(db,scope,event,'RECORD_INTERNAL_TRANSFER','church_financial_operations',id,{amount_cents:amount,from_account_id:from.id,to_account_id:to.id,operating_income:false});
  return{id,recorded:true};
 });
}

export async function reverseSettlement(scope:IntelligenceScope,settlementId:string,body:any,event:any) {
 const id=uuid(body.request_id),settlement=uuid(settlementId),amount=cents(body.amount_cents),on=date(body.occurred_on),reason=text(body.reason,8,240);
 if(!['CORRECTION','REFUND'].includes(body.kind))throw new IntelligenceError(400,'Escolha correção do registro ou devolução efetiva.');
 const evidence=text(body.evidence_reference,3,255),fingerprint=hash({kind:body.kind,settlement,amount,on,reason,evidence,actor:scope.user.userId});
 return transaction(async db=>{
  const [observed]=await db.query('SELECT account_id,transaction_id FROM church_financial_settlements WHERE organization_id = ? AND id = ?',[scope.organizationId,settlement]);
  if(!observed.length)throw new IntelligenceError(404,'Liquidação não encontrada neste acesso.');
  const a=await account(db,scope,observed[0].account_id,true);await enabled(scope,a.campus_id);
  const t=await posting(db,scope,observed[0].transaction_id,true);
  if(await existing(db,scope.organizationId,id,fingerprint))return{id,recorded:false};
  if(a.status!=='ACTIVE'||t.account_id!==a.id)throw new IntelligenceError(409,'Conta ou lançamento indisponível.');
  if(requireVersion(body.expected_version)!==Number(t.ledger_lock_version))throw new IntelligenceError(409,'O lançamento mudou. Atualize antes de revisar.');
  const [source]=await db.query("SELECT amount_cents,DATE_FORMAT(settled_on,'%Y-%m-%d') AS settled_on FROM church_financial_settlements WHERE organization_id = ? AND id = ? FOR UPDATE",[scope.organizationId,settlement]);
  const [reversed]=await db.query('SELECT COALESCE(SUM(amount_cents),0) AS total FROM church_financial_operations WHERE organization_id = ? AND settlement_id = ?',[scope.organizationId,settlement]);
  if(on<source[0].settled_on||on<a.opening_on)throw new IntelligenceError(400,'A revisão não pode anteceder a liquidação nem a abertura da conta.');
  if(amount>Number(source[0].amount_cents)-Number(reversed[0].total))throw new IntelligenceError(409,'O valor supera o saldo reversível desta liquidação.');
  await db.query(`INSERT INTO church_financial_operations(organization_id,id,kind,settlement_id,transaction_id,amount_cents,occurred_on,reason,evidence_reference,request_hash,created_by,created_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6))`,[scope.organizationId,id,body.kind,settlement,t.id,amount,on,reason,evidence,fingerprint,scope.user.userId]);
  await db.query(`INSERT INTO church_financial_cash_movements(organization_id,operation_id,leg,account_id,campus_id,amount_cents,occurred_on) VALUES(?,?,0,?,?,?,?)`,[scope.organizationId,id,a.id,a.campus_id,t.type==='INCOME'?-amount:amount,on]);
  // Corrections undo a mistaken settlement and reopen its forecast. Actual refunds remain separate facts.
  const effective=await paid(db,scope.organizationId,t.id),status=effective>=decimalCents(t.amount)?'PAID':'PENDING';
  await db.query('UPDATE church_financial_transactions SET status=?,ledger_lock_version=ledger_lock_version+1,updated_at=UTC_TIMESTAMP() WHERE organization_id = ? AND id = ?',[status,scope.organizationId,t.id]);
  if(t.type==='INCOME'&&t.project_id)await db.query('UPDATE church_special_projects SET collected_amount=collected_amount-? WHERE organization_id = ? AND id = ?',[money(amount),scope.organizationId,t.project_id]);
  await audit(db,scope,event,body.kind==='REFUND'?'RECORD_FINANCIAL_REFUND':'CORRECT_FINANCIAL_SETTLEMENT','church_financial_operations',id,{settlement_id:settlement,transaction_id:t.id,kind:body.kind,amount_cents:amount,evidence_reference:evidence,bank_operation_executed:false});
  return{id,recorded:true,version:Number(t.ledger_lock_version)+1,status};
 });
}

export async function listFinancialMovements(scope:IntelligenceScope,page=0) {
 if(!Number.isInteger(page)||page<0||page>100)throw new IntelligenceError(400,'Página inválida.');
 const f=scopedWhere(scope,'m');
 const {rows}=await query(`SELECT m.operation_id,m.leg,m.account_id,m.campus_id,m.amount_cents,a.name AS account_name,o.kind,o.reason,o.evidence_reference,
 DATE_FORMAT(m.occurred_on,'%Y-%m-%d') AS occurred_on,DATE_FORMAT(o.created_at,'%Y-%m-%dT%H:%i:%s.000Z') AS recorded_at
 FROM church_financial_cash_movements m INNER JOIN church_financial_operations o ON o.organization_id=m.organization_id AND o.id=m.operation_id
 INNER JOIN church_financial_accounts a ON a.organization_id=m.organization_id AND a.id=m.account_id
 WHERE m.organization_id = ?${f.sql} ORDER BY o.created_at DESC,m.operation_id,m.leg LIMIT 101 OFFSET ?`,[scope.organizationId,...f.params,page*100]);
 const movements=[];for(const row of rows.slice(0,100)){
  try{await enabled(scope,row.campus_id);movements.push({...row,amount_cents:Number(row.amount_cents)});}catch(e){if(!(e instanceof IntelligenceError&&e.status===403))throw e;}
 }
 return{movements,page,has_more:rows.length>100,notes:['Transferências são dois lados de uma única operação; não aumentam receitas ou despesas operacionais.','A lista mostra apenas os lados no seu acesso, sem revelar contrapartidas de outras unidades.','Correções e devoluções preservam a liquidação original. Este registro não executa pagamentos ou reembolsos no banco.']};
}
export async function financialMovementsHandler(event:any) {
 try{
  const auth=await requireAuth(event);if('errorResponse'in auth)return auth.errorResponse;
  const role=enforceRole(auth.user,LEDGER_ROLES);if(!role.allowed)return role.errorResponse!;
  if((event.body||'').length>32768)throw new IntelligenceError(413,'Solicitação muito grande.');
  const body=JSON.parse(event.body||'{}');if(!body||typeof body!=='object'||Array.isArray(body))throw new IntelligenceError(400,'Envie um objeto JSON.');
  const scope=await intelligenceScope(event,auth.user,body);if('statusCode'in scope)return scope;
  await enabled(scope,scope.campusId);
  const rate=await checkRateLimit(event,{maxRequests:30,windowSeconds:60,identifierPrefix:'financial-movements:'+scope.organizationId+':'+auth.user.userId});if(!rate.allowed)return rate.errorResponse!;
  const path=(event.rawPath||event.path||'').split('/').filter(Boolean),route=path.slice(path.indexOf('ledger')+1),method=event.requestContext?.http?.method||event.httpMethod;
  let result;
  if(method==='GET'&&route[0]==='movements'&&route.length===1)result=await listFinancialMovements(scope,Number(event.queryStringParameters?.page||0));
  else if(method==='POST'&&route[0]==='transfers'&&route.length===1)result=await transferAccounts(scope,body,event);
  else if(method==='POST'&&route[0]==='settlements'&&route[2]==='reversals'&&route.length===3)result=await reverseSettlement(scope,route[1],body,event);
  else return apiResponse(404,{message:'Recurso não encontrado.'});
  return apiResponse(200,result,{'Cache-Control':'no-store'});
 }catch(e){if(e instanceof IntelligenceError)return apiResponse(e.status,{message:e.message});if(e instanceof SyntaxError)return apiResponse(400,{message:'JSON inválido.'});console.error('Financial movement unavailable',{name:(e as Error).name});return apiResponse(503,{message:'Não foi possível registrar ou consultar a revisão financeira.'});}
}
