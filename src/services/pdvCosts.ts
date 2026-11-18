import {createHash} from 'crypto';
import {logSecurityEvent} from './auditLogService';
import {query} from '../db';
import {evaluateTenantFlags} from './featureFlagService';
import {IntelligenceError} from './intelligenceUsage';
import {IntelligenceScope,scopedWhere} from './intelligenceScope';
export const costHash=(v:any)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function quantityUnits(n:any):bigint{const s=String(n);if(!/^-?\d+(\.\d{1,3})?$/.test(s)||Math.abs(Number(n))>999999999)throw new IntelligenceError(400,'Use quantidade com até três casas decimais.');const neg=s.startsWith('-'),[a,b='']=(neg?s.slice(1):s).split('.');return (BigInt(a)*1000n+BigInt(b.padEnd(3,'0')))*(neg?-1n:1n);}
export function money(n:any):bigint{if(!Number.isSafeInteger(n)||n<0||n>999999999999)throw new IntelligenceError(400,'Informe o custo em centavos inteiros.');return BigInt(n);}
export function allocateCost(value:bigint|null,quantity:bigint,out:bigint){return value===null||quantity<=0n||out>quantity?null:(value*out+quantity/2n)/quantity;}
export async function costGate(org:string,campus:string){const f=(await evaluateTenantFlags(org,campus,'production')).flags;return !!(f['pdv.historical_costs']&&f['pdv.stock_inventory']&&f['pdv.module_enabled']);}
export async function costPool(db:any,org:string,campus:string,product:string,before:number,enabled:boolean){
 const [rows]=await db.query('SELECT quantity,value_cents FROM pdv_cost_pools WHERE organization_id = ? AND campus_id = ? AND product_id = ? FOR UPDATE',[org,campus,product]);
 if(!rows.length&&!enabled)return null;
 if(!rows.length){await db.query('INSERT INTO pdv_cost_pools(organization_id,campus_id,product_id,quantity,value_cents,updated_at) VALUES(?,?,?,?,?,UTC_TIMESTAMP(6))',[org,campus,product,before,before===0?0:null]);return {quantity:quantityUnits(before),value:before===0?0n:null};}
 const qty=quantityUnits(rows[0].quantity),expected=quantityUnits(before);
 // Legacy paths or an interruption in tracking cannot create a fictitious cost.
 return {quantity:expected,value:qty===expected&&rows[0].value_cents!==null?BigInt(rows[0].value_cents):null};
}
export async function savePool(db:any,org:string,campus:string,product:string,qty:bigint,value:bigint|null){if(value!==null&&(value<0n||value>999999999999999n))throw new IntelligenceError(400,'O valor do estoque ultrapassa o limite.');await db.query('UPDATE pdv_cost_pools SET quantity=?,value_cents=?,updated_at=UTC_TIMESTAMP(6) WHERE organization_id = ? AND campus_id = ? AND product_id = ?',[Number(qty)/1000,value===null?null:String(value),org,campus,product]);}
async function auditCost(db:any,org:string,campus:string,actor:string|undefined,ref:string,details:any){await logSecurityEvent({organizationId:org,campusId:campus,user:actor?{userId:actor,role:'SYSTEM'} as any:undefined,action:'RECORD_PDV_HISTORICAL_COST',resource:'pdv_cost_events',resourceId:ref,details,strict:true,executor:(s,p)=>db.query(s,p)});}
export async function manualCost(db:any,input:any,before:number,after:number,id:string,enabled:boolean){
 const provided=input.totalCostCents!==undefined&&input.totalCostCents!==null;
 if(provided&&!enabled)throw new IntelligenceError(403,'Custos históricos não estão habilitados.');
 if(input.sourceReference!=null&&(typeof input.sourceReference!=='string'||input.sourceReference.length>200||/[\x00-\x1f]/.test(input.sourceReference)))throw new IntelligenceError(400,'Referência de origem inválida.');
 const pool=await costPool(db,input.organizationId,input.campusId,input.productId,before,enabled);if(!pool)return;
 const delta=quantityUnits(after)-quantityUnits(before);
 if(provided&&!['ENTRY','OPENING_BALANCE'].includes(input.type))throw new IntelligenceError(400,'Informe custo somente em entradas ou saldo inicial conferido.');
 if(provided&&(!input.sourceReference||input.sourceReference.trim().length<3||input.sourceReference.length>200))throw new IntelligenceError(400,'Informe a referência da origem do custo.');
 if(!provided&&input.additionalCostCents)throw new IntelligenceError(400,'Custos adicionais exigem o custo total dos itens, inclusive zero comprovado.');
 let cost=provided?money(input.totalCostCents)+money(input.additionalCostCents??0):null,value:bigint|null;
 if(provided&&((input.type==='ENTRY'&&delta<=0n)||(quantityUnits(after)===0n&&cost!==null&&cost>0n)))throw new IntelligenceError(400,'Uma entrada com custo exige quantidade positiva.');
 if(input.type==='OPENING_BALANCE'){if(before!==0)throw new IntelligenceError(409,'Saldo inicial com custo exige estoque vazio; ajuste quantidades sem reescrever a avaliação anterior.');value=cost;}
 else if(delta>0n)value=pool.quantity===0n?cost:pool.value===null||cost===null?null:pool.value+cost;
 else {cost=allocateCost(pool.value,pool.quantity,-delta);value=pool.value===null||cost===null?null:pool.value-cost;}
 if(quantityUnits(after)===0n)value=0n;
 await savePool(db,input.organizationId,input.campusId,input.productId,quantityUnits(after),value);
 await db.query(`INSERT INTO pdv_cost_events(organization_id,id,campus_id,product_id,kind,quantity,cost_cents,reference,reason,actor_id,request_hash,result_json,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6))`,[input.organizationId,'manual:'+id,input.campusId,input.productId,input.type,Number(delta)/1000,cost===null?null:String(cost),input.sourceReference||'Custo não informado',input.reason,input.actorId,costHash(input),JSON.stringify({previousOnHand:before,newOnHand:after})]);
 await auditCost(db,input.organizationId,input.campusId,input.actorId,id,{kind:input.type,costKnown:cost!==null,reference:input.sourceReference||null});
}
export async function saleCost(db:any,input:any,reservation:any,before:number,transition:'COMMIT'|'CANCEL',enabled:boolean){
 const {organizationId:org,orderId:order}=input,campus=reservation.campus_id,product=reservation.product_id,qty=quantityUnits(reservation.quantity);
 const pool=await costPool(db,org,campus,product,before,enabled);if(!pool)return;
 if(transition==='COMMIT'){
  const [items]=await db.query('SELECT SUM(ROUND(line_total*100)) AS revenue FROM pdv_order_items WHERE organization_id = ? AND order_id = ? AND product_id = ?',[org,order,product]);
  const cost=allocateCost(pool.value,pool.quantity,qty),remaining=pool.quantity-qty;
  await db.query('INSERT INTO pdv_sale_costs(organization_id,order_id,campus_id,product_id,quantity,cost_cents,revenue_cents,recorded_at) VALUES(?,?,?,?,?,?,?,UTC_TIMESTAMP(6))',[org,order,campus,product,reservation.quantity,cost===null?null:String(cost),String(items[0]?.revenue??0)]);
  await savePool(db,org,campus,product,remaining,remaining===0n?0n:cost===null||pool.value===null?null:pool.value-cost);
 }else{
  const [sales]=await db.query('SELECT cost_cents,reversed FROM pdv_sale_costs WHERE organization_id = ? AND order_id = ? AND product_id = ? FOR UPDATE',[org,order,product]);
  const original=sales[0];if(original?.reversed)throw new IntelligenceError(409,'A devolução deste item já foi registrada.');
  const cost=original?.cost_cents===undefined||original.cost_cents===null?null:BigInt(original.cost_cents);
  await savePool(db,org,campus,product,pool.quantity+qty,pool.quantity===0n?cost:pool.value===null||cost===null?null:pool.value+cost);
  if(original)await db.query('UPDATE pdv_sale_costs SET reversed=1 WHERE organization_id = ? AND order_id = ? AND product_id = ?',[org,order,product]);
 }
 await auditCost(db,org,campus,input.actorId,order,{kind:transition,product,costPolicy:'MOVING_AVERAGE'});
}
export async function costMargins(scope:IntelligenceScope,start:string,end:string){
 if(!['SUPERADMIN','PASTOR','ADMIN','TREASURER'].includes(scope.user.role)||scope.cellIds!==null)throw new IntelligenceError(403,'Margem exige acesso financeiro à loja.');
 const filter=scopedWhere(scope,'o');const {rows:campuses}=await query('SELECT id FROM campuses WHERE organization_id = ?',[scope.organizationId]);const allowed=[];
 for(const c of campuses)if((scope.campusIds===null||scope.campusIds.includes(c.id))&&await costGate(scope.organizationId,c.id))allowed.push(c.id);
 if(!allowed.length)throw new IntelligenceError(403,'Custos históricos não estão habilitados neste acesso.');
 const {rows}=await query(`SELECT COUNT(*) AS items,COALESCE(SUM(ROUND(i.line_total*100)),0) AS total_revenue_cents,
 SUM(s.cost_cents IS NOT NULL AND s.reversed=0) AS covered_items,
 COALESCE(SUM(IF(s.cost_cents IS NOT NULL AND s.reversed=0,s.revenue_cents,0)),0) AS covered_revenue_cents,
 COALESCE(SUM(IF(s.reversed=0,s.cost_cents,0)),0) AS cost_cents
 FROM pdv_order_items i INNER JOIN pdv_orders o ON o.organization_id=i.organization_id AND o.id=i.order_id
 LEFT JOIN pdv_sale_costs s ON s.organization_id=i.organization_id AND s.order_id=i.order_id AND s.product_id=i.product_id
 WHERE o.organization_id = ? AND o.payment_status='PAID' AND o.status<>'CANCELADO' AND o.paid_at>=? AND o.paid_at<?${filter.sql} AND o.campus_id IN (${allowed.map(()=>'?').join(',')})`,[scope.organizationId,start,end,...filter.params,...allowed]);
 const r=Object.fromEntries(Object.entries(rows[0]).map(([k,v])=>[k,Number(v||0)])),covered=r.covered_items;
 return {...r,cost_cents:covered?r.cost_cents:null,gross_margin_cents:covered?r.covered_revenue_cents-r.cost_cents:null,coverage_percent:r.items?Math.round(covered/r.items*1000)/10:null,definition:'Cobertura por linhas de produto/pedido, não por unidades. Margem bruta apenas das linhas com custo histórico conhecido; não é lucro líquido. Itens legados ou estoque sem custo comprovado permanecem descobertos.'};
}
