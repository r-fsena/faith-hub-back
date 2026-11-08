import {createHash,randomUUID} from 'crypto';
import {query} from '../db';
import {evaluateTenantFlags} from './featureFlagService';
/** Operational provider result, never delivery/read/password completion. No address or message body. */
export async function recordInvitationMilestone(org:string,userId:string,source:'CSV'|'INVITE'|'RESEND',outcome:'REGISTERED'|'REQUESTED'|'FAILED',event:any,enabled?:boolean){
 try{
  if(enabled===undefined)enabled=!!(await evaluateTenantFlags(org,null,'production')).flags['intelligence.activation'];
  if(!enabled)return true;
  const requestId=String(event?.requestContext?.requestId||randomUUID());
  const id=createHash('sha256').update(`${org}:${userId}:${source}:${outcome}:${requestId}`).digest('hex');
  await query(`INSERT IGNORE INTO intelligence_invitation_events(organization_id,id,user_id,campus_id,source,outcome,occurred_at)
   SELECT organization_id,?,id,COALESCE(campus_id,'campus_sede'),?,?,UTC_TIMESTAMP() FROM members WHERE organization_id = ? AND id = ?`,[id,source,outcome,org,userId]);
  return true;
 }catch{console.error('Marco de convite pendente',{organizationId:org,source,outcome});return false;}
}
