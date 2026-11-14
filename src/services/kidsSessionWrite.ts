import {getConnection} from '../db';
import {AuditLogEntry,logSecurityEvent} from './auditLogService';
/** The child write, capacity trigger and mandatory audit either all commit or all roll back. */
export async function auditedKidsStatement(sql:string,params:any[],audit:AuditLogEntry,before?:(db:any)=>Promise<void>){
 const db=await getConnection();try{await db.beginTransaction();if(before)await before(db);const result=await db.query(sql,params);await logSecurityEvent({...audit,strict:true,executor:(s,p)=>db.query(s,p)});await db.commit();return result;}catch(e){await db.rollback();throw e;}finally{db.release();}
}
