import {query} from '../db';
import {IntelligenceScope,scopedWhere} from './intelligenceScope';
import {IntelligencePeriod,utcBoundary} from './intelligenceModel';
import {calendarTime} from './intelligenceCalendarModel';
import {IntelligenceError} from './intelligenceUsage';
const parse=(v:any)=>typeof v==='string'?JSON.parse(v):v;
const sqlTime=(day:string)=>utcBoundary(day).slice(0,19).replace('T',' ');
function window(period:IntelligencePeriod,column:string){return{sql:`((${column}>=? AND ${column}<?) OR (${column}>=? AND ${column}<?))`,params:[period.start,period.end,period.previousStart,period.previousEnd]};}
export async function capacitiesObserved(scope:IntelligenceScope){const f=scopedWhere(scope,'r');const {rows}=await query(`SELECT r.campus_id FROM intelligence_capacity_rollout r WHERE r.organization_id = ?${f.sql} LIMIT 1`,[scope.organizationId,...f.params]);return !!rows.length;}
export async function capacityAsOf(org:string,kind:string,requests:Array<{id:string;cutoff:string}>){
 const result=new Map<string,any>();
 for(let offset=0;offset<requests.length;offset+=80){const batch=requests.slice(offset,offset+80);if(!batch.length)continue;
 const definitions=batch.map(()=>"SELECT ? AS source_id,CAST(? AS DATETIME) AS cutoff").join(' UNION ALL '),params=batch.flatMap(r=>[r.id,r.cutoff]);
 const {rows}=await query(`WITH cutoffs AS (${definitions}), ranked AS (SELECT r.source_id,r.snapshot_json,r.id,r.version,r.recorded_at,
 ROW_NUMBER() OVER(PARTITION BY r.source_id ORDER BY r.recorded_at DESC,r.version DESC) AS rank_number
 FROM intelligence_capacity_revisions r INNER JOIN cutoffs c ON c.source_id COLLATE utf8mb4_unicode_ci=r.source_id COLLATE utf8mb4_unicode_ci
 WHERE r.organization_id = ? AND r.source_kind = ? AND r.recorded_at<=c.cutoff) SELECT source_id,snapshot_json,id,version FROM ranked WHERE rank_number=1`,[...params,org,kind]);
 for(const r of rows)result.set(r.source_id,{...r,snapshot:parse(r.snapshot_json)});
 }
 return result;
}
export async function historicalScheduleMetrics(scope:IntelligenceScope,ids:string[],period:IntelligencePeriod){
 const f=scopedWhere({...scope,campusIds:ids,cellIds:null},'s'),w=window(period,'s.service_date');
 const {rows}=await query(`SELECT s.id,s.ministry_id,COALESCE(s.campus_id,'campus_sede') AS campus_id,DATE_FORMAT(s.service_date,'%Y-%m-%d') AS service_date,s.service_time FROM service_schedules s WHERE s.organization_id = ? AND s.status IN ('PUBLISHED','COMPLETED') AND ${w.sql}${f.sql} ORDER BY s.id LIMIT 5001`,[scope.organizationId,...w.params,...f.params]);if(rows.length>5000)throw new IntelligenceError(413,'Restrinja o período ou as unidades para consultar as escalas.');
 const wanted=[];for(const s of rows){try{wanted.push({id:s.id,cutoff:calendarTime(s.service_date,String(s.service_time).slice(0,5))});}catch{}}
 const snapshots=await capacityAsOf(scope.organizationId,'SCHEDULE',wanted),accepted=new Map<string,Map<string,number>>();
 for(let i=0;i<rows.length;i+=100){const batch=rows.slice(i,i+100),placeholders=batch.map(()=>'?').join(',');const {rows:items}=await query(`SELECT schedule_id,role_id,COUNT(DISTINCT member_id) AS n FROM service_roster_items WHERE organization_id = ? AND schedule_id IN (${placeholders}) AND status='ACCEPTED' GROUP BY schedule_id,role_id`,[scope.organizationId,...batch.map(s=>s.id)]);for(const r of items){if(!accepted.has(r.schedule_id))accepted.set(r.schedule_id,new Map());accepted.get(r.schedule_id)!.set(r.role_id,Number(r.n));}}
 return rows.map(s=>{const snapshot=snapshots.get(s.id)?.snapshot,roles=snapshot?.service_date===s.service_date&&String(snapshot?.service_time).slice(0,5)===String(s.service_time).slice(0,5)&&snapshot?.ministry_id===s.ministry_id&&Array.isArray(snapshot.roles)?snapshot.roles:null,actual=accepted.get(s.id)||new Map();
 return{id:s.id,campus_id:s.campus_id,bucket:s.service_date>=period.start?'current':'previous',schedules:1,required_slots:roles?roles.reduce((n:number,r:any)=>n+Number(r.minimum),0):0,accepted_slots:[...actual.values()].reduce((n,v)=>n+v,0),uncovered_slots:roles?roles.reduce((n:number,r:any)=>n+Math.max(0,Number(r.minimum)-(actual.get(r.role_id)||0)),0):0,unversioned_schedules:roles?0:1};});
}
export async function historicalEventMetrics(scope:IntelligenceScope,ids:string[],period:IntelligencePeriod){
 const f=scopedWhere({...scope,campusIds:ids,cellIds:null},'e'),w=window(period,'e.start_date'),range=[sqlTime(period.start),sqlTime(period.end),sqlTime(period.previousStart),sqlTime(period.previousEnd)];
 const {rows}=await query(`SELECT e.id,COALESCE(e.campus_id,'campus_sede') AS campus_id,DATE_FORMAT(e.start_date,'%Y-%m-%d %H:%i:%s') AS starts_at,COUNT(t.id) AS all_tickets,SUM(t.status IN ('PAID','USED')) AS tickets,SUM(t.status='USED' AND t.scanned_at IS NOT NULL) AS checked_tickets,SUM(t.status='CANCELED') AS cancelled_tickets FROM events e LEFT JOIN event_tickets t ON t.organization_id=e.organization_id AND t.event_id=e.id WHERE e.organization_id = ? AND e.status IN ('PUBLISHED','FINISHED') AND ${w.sql}${f.sql} GROUP BY e.id,e.campus_id,e.start_date ORDER BY e.id LIMIT 5001`,[scope.organizationId,...range,...f.params]);if(rows.length>5000)throw new IntelligenceError(413,'Restrinja o período ou as unidades para consultar os eventos.');
 const lots:any[]=[],events=new Map(rows.map(e=>[e.id,e]));for(let i=0;i<rows.length;i+=100){const batch=rows.slice(i,i+100);const {rows:items}=await query(`SELECT id,event_id FROM event_lots WHERE organization_id = ? AND event_id IN (${batch.map(()=>'?').join(',')})`,[scope.organizationId,...batch.map(e=>e.id)]);lots.push(...items);}
 const snapshots=await capacityAsOf(scope.organizationId,'EVENT_LOT',lots.map(l=>({id:l.id,cutoff:events.get(l.event_id).starts_at})));
 return rows.map(e=>{const edition=lots.filter(l=>l.event_id===e.id),valid=edition.filter(l=>snapshots.get(l.id)?.snapshot?.event_id===e.id);return{...e,bucket:e.starts_at>=sqlTime(period.start)?'current':'previous',events:1,ticket_capacity:valid.reduce((n,l)=>n+Number(snapshots.get(l.id).snapshot.capacity),0),unversioned_events:edition.length&&valid.length===edition.length?0:1};});
}
