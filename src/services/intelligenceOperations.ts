import {query} from '../db';
import {IntelligenceScope,scopedWhere} from './intelligenceScope';
import {evaluateTenantFlags} from './featureFlagService';
import {intelligencePeriod,utcBoundary,variation} from './intelligenceModel';
import {IntelligenceError} from './intelligenceUsage';

export const FINANCE_ROLES=['SUPERADMIN','PASTOR','ADMIN','TREASURER'];
export const OPERATIONS_ROLES=['SUPERADMIN','PASTOR','ADMIN'];
type View='finance'|'operations'|'units';
type Values=Record<string,number>;
const DEFINITIONS:Record<string,[string,string,string]>={
 income:['Receitas pagas','BRL_CENTS','Lançamentos INCOME/PAID pela data de pagamento informada na tesouraria.'],
 expense:['Despesas pagas','BRL_CENTS','Lançamentos EXPENSE/PAID pela data de pagamento informada na tesouraria.'],
 result:['Resultado registrado','BRL_CENTS','Receitas pagas menos despesas pagas. Não representa saldo bancário nem DRE por competência.'],
 pending_income:['Receitas pendentes','BRL_CENTS','Pendências com data de pagamento informada na janela; não são recebimentos confirmados.'],
 pending_expense:['Despesas pendentes','BRL_CENTS','Pendências com data de pagamento informada na janela; não são pagamentos confirmados.'],
 cancelled:['Lançamentos cancelados','count','Registros cancelados na janela; excluídos das receitas/despesas pagas.'],
 events:['Eventos registrados','count','Edições publicadas/finalizadas pela data de início informada no evento; não pela data de compra.'],
 tickets:['Inscrições válidas','count','Ingressos PAID ou USED das edições da janela, posição atual; inclui inscrições gratuitas.'],
 checked_tickets:['Check-ins registrados','count','Ingressos USED com leitura registrada das edições da janela; não são pessoas únicas.'],
 cancelled_tickets:['Inscrições canceladas','count','Ingressos CANCELED das edições da janela; excluídos das inscrições válidas.'],
 ticket_capacity:['Vagas configuradas','count','Soma das capacidades dos lotes das edições da janela. Não comprova capacidade física ou calendário completo.'],
 paid_orders:['Pedidos pagos','count','Pedidos PAID não cancelados, com paid_at conhecido, pela data UTC do pagamento convertida aos limites de Brasília.'],
 average_ticket:['Ticket médio pago','BRL_CENTS','Vendas pagas divididas pelos pedidos elegíveis, arredondadas ao centavo; sem pedidos, não há média.'],
 sales:['Vendas pagas','BRL_CENTS','Valor bruto dos pedidos elegíveis; separado da tesouraria, sem presumir margem ou receita adicional.'],
 sold_units:['Itens vendidos','quantity','Quantidade de itens dos pedidos elegíveis, sem multiplicar o valor do pedido por item.'],
 undated_orders:['Pagamentos sem data','count','Posição atual de pedidos pagos sem paid_at; excluídos das comparações de vendas.'],
 low_stock:['Saldos abaixo do mínimo','count','Posição atual de produto/unidade com saldo disponível menor ou igual ao mínimo cadastrado.'],
 schedules:['Escalas publicadas','count','Escalas PUBLISHED/COMPLETED pela data do serviço registrada.'],
 required_slots:['Vagas configuradas em escalas','count','Mínimos atuais das funções do ministério aplicados às escalas da janela; alterações de configuração podem revisar o resultado.'],
 accepted_slots:['Alocações confirmadas','count','Membros distintos por escala/função com aceite. A mesma pessoa em funções diferentes conta em cada alocação.'],
 uncovered_slots:['Vagas sem aceite','count','Soma por escala/função de máximo entre zero e mínimo configurado menos aceites; excesso numa função não cobre outra.'],
 kids_checkins:['Entradas Kids registradas','count','Check-ins operacionais na janela; não são crianças únicas nem perfil comportamental.'],
 kids_open:['Check-ins Kids em aberto','count','Posição atual CHECKED_IN/CALLING_PARENTS; pode incluir registros antigos sem checkout.'],
 kids_capacity:['Capacidade Kids cadastrada','count','Capacidade atual das salas cadastradas por unidade; não é histórico de capacidade por turno.'],
};
export function operationChange(value:number|null,previous:number|null){
 if(value!==null&&previous!==null&&(value<0||previous<0))return{delta:value-previous,percent:null,reason:'signed_balance'};
 return variation(value,previous);
}
const number=(value:any)=>{const n=Number(value??0);if(!Number.isSafeInteger(n))throw Error('INVALID_AGGREGATE');return n;};
const metric=(key:string,current:Values,previous:Values,snapshot=false)=>{
 const value=key==='average_ticket'?(current.paid_orders?Math.round(current.sales/current.paid_orders):null):current[key]??0;
 const old=snapshot?null:key==='average_ticket'?(previous.paid_orders?Math.round(previous.sales/previous.paid_orders):null):previous[key]??0;
 return{key,title:DEFINITIONS[key][0],unit:DEFINITIONS[key][1],definition:DEFINITIONS[key][2],value,previous:old,change:operationChange(value,old),reference:snapshot?'current_state':'selected_period'};
};
const SOURCE_CONFIG={finance:['financial.module_enabled','financial.cashflow_ledger'],events:['events.module_enabled'],store:['pdv.module_enabled'],stock:['pdv.module_enabled','pdv.stock_inventory'],teams:['ministries.module_enabled','volunteers.module_enabled'],kids:['kids.module_enabled','kids.reports_export']} as const;

export async function intelligenceOperations(scope:IntelligenceScope,preset:string,view:View){
 if(!FINANCE_ROLES.includes(scope.user.role)||scope.cellIds!==null)throw new IntelligenceError(403,'Este perfil não pode consultar a gestão consolidada.');
 if(view==='operations'&&!OPERATIONS_ROLES.includes(scope.user.role))throw new IntelligenceError(403,'Operação exige perfil de administração ou pastoral.');
 const period=intelligencePeriod(preset),campusFilter=scopedWhere(scope,'c','id');
 const {rows:campuses}=await query(`SELECT c.id,c.name FROM campuses c WHERE c.organization_id = ?${campusFilter.sql} ORDER BY c.name,c.id LIMIT 201`,[scope.organizationId,...campusFilter.params]);
 if(campuses.length>200)throw new IntelligenceError(400,'Selecione uma unidade para consultar este volume de dados.');
 const campusFlags:Record<string,Record<string,boolean>>={};
 for(let i=0;i<campuses.length;i+=4)await Promise.all(campuses.slice(i,i+4).map(async(c:any)=>{campusFlags[c.id]=(await evaluateTenantFlags(scope.organizationId,c.id,'production')).flags;}));
 const unitList=campuses.map((c:any)=>({id:c.id,name:c.name,sources:{} as Record<string,any>}));
 const sources:Record<string,any>={};
 const utc=(day:string)=>utcBoundary(day).slice(0,19).replace('T',' ');
 const scopeFor=(ids:string[],alias:string)=>scopedWhere({...scope,campusIds:ids,cellIds:null},alias);
 async function source(key:keyof typeof SOURCE_CONFIG,keys:string[],load:(ids:string[])=>Promise<any[]>,snapshots:string[]=[]){
  const wanted=key==='finance'?(view!=='operations'):view!=='finance'&&scope.user.role!=='TREASURER';
  const rollout=key==='finance'?'intelligence.finance':'intelligence.operations';
  const ids=campuses.filter((c:any)=>wanted&&(view!=='units'||campusFlags[c.id]['intelligence.multicampus']&&campusFlags[c.id]['system.multicampus_enabled'])&&campusFlags[c.id][rollout]&&SOURCE_CONFIG[key].every(flag=>campusFlags[c.id][flag])).map((c:any)=>c.id);
  const empty=(status:string)=>({status,metrics:keys.map(k=>({...metric(k,{},{}),value:null,previous:null,change:operationChange(null,null)}))});
  for(const unit of unitList)unit.sources[key]=empty('not_available');
  if(!ids.length){sources[key]=empty('not_available');return;}
  try{
   const rows=await load(ids),current:Values={},previous:Values={};
   for(const id of ids){const curr:Values={},prev:Values={};
    for(const row of rows.filter(r=>r.campus_id===id))for(const k of keys){const target=row.bucket==='previous'?prev:curr;
     const value=k==='sold_units'?Number(row[k]??0):number(row[k]);if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)throw Error('INVALID_AGGREGATE');target[k]=(target[k]||0)+value;}
    for(const k of keys){current[k]=(current[k]||0)+(curr[k]||0);previous[k]=(previous[k]||0)+(prev[k]||0);if(k!=='sold_units'&&(!Number.isSafeInteger(current[k])||!Number.isSafeInteger(previous[k])))throw Error('AGGREGATE_OVERFLOW');}
    unitList.find(c=>c.id===id)!.sources[key]={status:'available',metrics:keys.map(k=>metric(k,curr,prev,snapshots.includes(k)))};
   }
   sources[key]={status:'available',included_units:ids.length,metrics:keys.map(k=>metric(k,current,previous,snapshots.includes(k)))};
  }catch{
   sources[key]={...empty('error'),included_units:ids.length};for(const unit of unitList)if(ids.includes(unit.id))unit.sources[key]=empty('error');
  }
 }
 const buckets=(column:string,datetime=false)=>({
  sql:`CASE WHEN ${column} >= ? AND ${column} < ? THEN 'current' ELSE 'previous' END`,
  params:datetime?[utc(period.start),utc(period.end)]:[period.start,period.end],
  filter:`((${column} >= ? AND ${column} < ?) OR (${column} >= ? AND ${column} < ?))`,
  range:datetime?[utc(period.previousStart),utc(period.previousEnd),utc(period.start),utc(period.end)]:[period.previousStart,period.previousEnd,period.start,period.end]
 });
 const financeDetails:any={categories:[],coverage:'registered_ledger_only'};
 await source('finance',['income','expense','result','pending_income','pending_expense','cancelled'],async ids=>{
  const f=scopeFor(ids,'t'),b=buckets('t.payment_date');
  const {rows}=await query(`SELECT COALESCE(t.campus_id,'campus_sede') AS campus_id,${b.sql} AS bucket,
   SUM(CASE WHEN t.status='PAID' AND t.type='INCOME' THEN ROUND(t.amount*100) ELSE 0 END) AS income,
   SUM(CASE WHEN t.status='PAID' AND t.type='EXPENSE' THEN ROUND(t.amount*100) ELSE 0 END) AS expense,
   SUM(CASE WHEN t.status='PAID' THEN IF(t.type='INCOME',1,-1)*ROUND(t.amount*100) ELSE 0 END) AS result,
   SUM(CASE WHEN t.status='PENDING' AND t.type='INCOME' THEN ROUND(t.amount*100) ELSE 0 END) AS pending_income,
   SUM(CASE WHEN t.status='PENDING' AND t.type='EXPENSE' THEN ROUND(t.amount*100) ELSE 0 END) AS pending_expense,
   SUM(t.status='CANCELLED') AS cancelled
   FROM church_financial_reporting_transactions t WHERE t.organization_id = ? AND ${b.filter}${f.sql} GROUP BY campus_id,bucket`,[...b.params,scope.organizationId,...b.range,...f.params]);
  const categories=await query(`SELECT t.type,t.category,SUM(ROUND(t.amount*100)) AS amount_cents,COUNT(DISTINCT t.original_transaction_id) AS records
   FROM church_financial_reporting_transactions t WHERE t.organization_id = ? AND t.status='PAID' AND t.payment_date >= ? AND t.payment_date < ?${f.sql}
   GROUP BY t.type,t.category ORDER BY amount_cents DESC,t.type,t.category LIMIT 21`,[scope.organizationId,period.start,period.end,...f.params]);
  financeDetails.categories=categories.rows.slice(0,20).map(r=>({...r,amount_cents:number(r.amount_cents),records:number(r.records)}));financeDetails.categories_has_more=categories.rows.length>20;
  return rows;
 });
 await source('events',['events','tickets','checked_tickets','cancelled_tickets','ticket_capacity'],async ids=>{
  const f=scopeFor(ids,'e'),b=buckets('e.start_date');
  // Aggregate tickets per edition before application consolidation; a correlated
  // lot total avoids multiplying tickets by lots. No attendee fields are selected.
  const {rows}=await query(`SELECT COALESCE(e.campus_id,'campus_sede') AS campus_id,${b.sql} AS bucket,1 AS events,
   SUM(t.status IN ('PAID','USED')) AS tickets,SUM(t.status='USED' AND t.scanned_at IS NOT NULL) AS checked_tickets,
   SUM(t.status='CANCELED') AS cancelled_tickets,
   (SELECT COALESCE(SUM(l.total_capacity),0) FROM event_lots l WHERE l.event_id=e.id) AS ticket_capacity
   FROM events e LEFT JOIN event_tickets t ON t.event_id=e.id AND t.organization_id=e.organization_id AND t.organization_id = ?
   WHERE e.organization_id = ? AND e.status IN ('PUBLISHED','FINISHED') AND ${b.filter}${f.sql}
   GROUP BY e.id,e.organization_id,e.campus_id,e.start_date ORDER BY e.start_date,e.id LIMIT 5001`,[...b.params,scope.organizationId,scope.organizationId,...b.range,...f.params]);
  if(rows.length>5000)throw Error('EVENT_WINDOW_TOO_LARGE');return rows;
 });
 await source('store',['paid_orders','sales','average_ticket','sold_units','undated_orders'],async ids=>{
  const f=scopeFor(ids,'o'),b=buckets('o.paid_at',true);
  const {rows}=await query(`SELECT COALESCE(o.campus_id,'campus_sede') AS campus_id,${b.sql} AS bucket,COUNT(*) AS paid_orders,SUM(ROUND(o.total_price*100)) AS sales,
   SUM((SELECT COALESCE(SUM(i.quantity),0) FROM pdv_order_items i WHERE i.organization_id = ? AND i.order_id=o.id)) AS sold_units
   FROM pdv_orders o WHERE o.organization_id = ? AND o.payment_status='PAID' AND o.status <> 'CANCELADO' AND ${b.filter}${f.sql} GROUP BY campus_id,bucket`,[...b.params,scope.organizationId,scope.organizationId,...b.range,...f.params]);
  const unknown=await query(`SELECT COALESCE(o.campus_id,'campus_sede') AS campus_id,'current' AS bucket,COUNT(*) AS undated_orders FROM pdv_orders o
   WHERE o.organization_id = ? AND o.payment_status='PAID' AND o.status <> 'CANCELADO' AND o.paid_at IS NULL${f.sql} GROUP BY campus_id`,[scope.organizationId,...f.params]);return [...rows,...unknown.rows];
 },['undated_orders']);
 await source('stock',['low_stock'],async ids=>{
  const f=scopeFor(ids,'b');return(await query(`SELECT b.campus_id,'current' AS bucket,COUNT(*) AS low_stock FROM pdv_inventory_balances b
   INNER JOIN pdv_products p ON p.id=b.product_id AND p.organization_id=b.organization_id WHERE b.organization_id = ? AND p.status='ACTIVE' AND p.track_inventory=1
   AND b.on_hand_quantity-b.reserved_quantity <= b.minimum_stock${f.sql} GROUP BY b.campus_id`,[scope.organizationId,...f.params])).rows;
 },['low_stock']);
 await source('teams',['schedules','required_slots','accepted_slots','uncovered_slots'],async ids=>{
  const f=scopeFor(ids,'s'),b=buckets('s.service_date');
  return(await query(`WITH roles AS (SELECT s.id,s.organization_id,COALESCE(s.campus_id,'campus_sede') AS campus_id,${b.sql} AS bucket,r.id AS role_id,
   GREATEST(COALESCE(r.min_volunteers,0),0) AS required_slots,COUNT(DISTINCT CASE WHEN i.status='ACCEPTED' THEN i.member_id END) AS accepted_slots
   FROM service_schedules s INNER JOIN ministries m ON m.organization_id=s.organization_id AND m.id=s.ministry_id
   LEFT JOIN ministry_roles r ON r.organization_id=s.organization_id AND r.ministry_id=s.ministry_id
   LEFT JOIN service_roster_items i ON i.organization_id=s.organization_id AND i.schedule_id=s.id AND i.role_id=r.id
   WHERE s.organization_id = ? AND s.status IN ('PUBLISHED','COMPLETED') AND ${b.filter}${f.sql}
   GROUP BY s.id,s.organization_id,s.campus_id,bucket,r.id,r.min_volunteers)
   SELECT campus_id,bucket,COUNT(DISTINCT id) AS schedules,SUM(required_slots) AS required_slots,SUM(accepted_slots) AS accepted_slots,
   SUM(GREATEST(0,required_slots-accepted_slots)) AS uncovered_slots FROM roles WHERE organization_id = ? GROUP BY campus_id,bucket`,[...b.params,scope.organizationId,...b.range,...f.params,scope.organizationId])).rows;
 });
 await source('kids',['kids_checkins','kids_open','kids_capacity'],async ids=>{
  const f=scopeFor(ids,'k'),r=scopeFor(ids,'r'),b=buckets('k.checkin_at',true);
  const historic=await query(`SELECT COALESCE(k.campus_id,'campus_sede') AS campus_id,${b.sql} AS bucket,COUNT(*) AS kids_checkins FROM kids_checkins k
   WHERE k.organization_id = ? AND k.status IN ('CHECKED_IN','CALLING_PARENTS','CHECKED_OUT') AND ${b.filter}${f.sql} GROUP BY campus_id,bucket`,[...b.params,scope.organizationId,...b.range,...f.params]);
  const open=await query(`SELECT COALESCE(k.campus_id,'campus_sede') AS campus_id,'current' AS bucket,COUNT(*) AS kids_open FROM kids_checkins k
   WHERE k.organization_id = ? AND k.status IN ('CHECKED_IN','CALLING_PARENTS')${f.sql} GROUP BY campus_id`,[scope.organizationId,...f.params]);
  const rooms=await query(`SELECT COALESCE(r.campus_id,'campus_sede') AS campus_id,'current' AS bucket,SUM(GREATEST(r.capacity,0)) AS kids_capacity FROM kids_rooms r
   WHERE r.organization_id = ?${r.sql} GROUP BY campus_id`,[scope.organizationId,...r.params]);return [...historic.rows,...open.rows,...rooms.rows];
 },['kids_open','kids_capacity']);
 if(sources.finance.status==='error'){financeDetails.categories=[];financeDetails.categories_has_more=false;}
 const notes=[
  'Somente unidades autorizadas e módulos liberados em cada unidade entram nos totais. Unidade nula legada é atribuída apenas a campus_sede, quando autorizada.',
  'Vendas da loja e inscrições não são somadas à tesouraria. Cada fonte descreve um aspecto da operação.',
  'A tesouraria não possui classificação estruturada de transferência interna ou estorno. O painel mostra lançamentos registrados, sem afirmar conciliação bancária. TRANSFER é meio de pagamento, não prova de transferência interna.',
  'Ingressos seguem a data informada da edição e sua situação atual, não a data de pagamento. Vagas de lotes e funções são a configuração atual; não representam histórico imutável.',
  'A loja não informa margem porque não existe custo histórico confiável nesta fonte. Atenção de estoque considera saldos cadastrados; produtos sem saldo exigem revisão na origem.',
  'Estoque, check-ins Kids em aberto, capacidade de salas e pedidos sem data são posições atuais, sem MoM retroativo. Kids contém apenas contagens operacionais, sem identificação de crianças.',
  'Comparações usam dias completos no fuso de Brasília. Falha de fonte mantém os valores indisponíveis; zero significa ausência de registros elegíveis consultados.',
 ];
 return{view,period,updated_at:new Date().toISOString(),currency:'BRL',scope:{campus_ids:campuses.map((c:any)=>c.id),financial_only:scope.user.role==='TREASURER'},sources,
  units:view==='units'?unitList:[],finance_details:view!=='operations'?financeDetails:undefined,notes,errors:Object.keys(sources).filter(k=>sources[k].status==='error')};
}
