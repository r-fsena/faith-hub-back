import {getConnection} from '../db';
import {AuthUser} from './authMiddleware';
import {logSecurityEvent} from './auditLogService';

export interface MemberWriteContext {organizationId:string;user?:AuthUser;actorId?:string;source:string;event?:any;memberId?:string;}
/** Context is cleared even on failure; a connection that cannot be cleared is destroyed. */
export async function memberStatement(db:any,sql:string,params:any[],context:MemberWriteContext){
 try{
 await db.query('SET @fh_history_org=?,@fh_history_actor=?,@fh_history_source=?,@fh_history_request=?',[
  context.organizationId,context.user?.userId||context.actorId||null,context.source.slice(0,40),String(context.event?.requestContext?.requestId||'').slice(0,100)||null]);
  const result=await db.query(sql,params);
  if(context.user)await logSecurityEvent({organizationId:context.organizationId,user:context.user,action:'MEMBER_STATE_WRITE',resource:'members',resourceId:context.memberId,
   details:{source:context.source},event:context.event,strict:true,executor:(s,p)=>db.query(s,p)});
  return result;
 }finally{try{await db.query('SET @fh_history_org=NULL,@fh_history_actor=NULL,@fh_history_source=NULL,@fh_history_request=NULL');}catch(error){db.destroy();throw error;}}
}
export async function memberStateWrite(sql:string,params:any[],context:MemberWriteContext){
 const db=await getConnection();let cleared=false;
 try{await db.beginTransaction();const result=await memberStatement(db,sql,params,context);await db.commit();return{rows:result[0]};}
 catch(error){await db.rollback();throw error;}
 finally{try{await db.query('SET @fh_history_org=NULL,@fh_history_actor=NULL,@fh_history_source=NULL,@fh_history_request=NULL');cleared=true;}catch{db.destroy();}if(cleared)db.release();}
}
