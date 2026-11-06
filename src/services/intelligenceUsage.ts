import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { createHash } from 'crypto';
import { query, getConnection } from '../db';
import { AuthUser, normalizeRole } from './authMiddleware';
import { logSecurityEvent } from './auditLogService';
import { evaluateTenantFlags } from './featureFlagService';
import { adultEligibility, dayInSaoPaulo, INTELLIGENCE_VERSION, subjectKey, validateUsageBatch, safeIdentifier, USAGE_MODULE_FLAGS, CONTENT_FLAGS } from './intelligenceModel';
import { contentExists } from '../functions/contentAnalytics';

const queue = new SQSClient({region: process.env.AWS_REGION || 'us-east-2'});
export class IntelligenceError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function usagePreference(org: string, user: AuthUser) {
  if (org !== user.organizationId) throw new IntelligenceError(403, 'As preferências de uso pertencem à sua própria igreja.');
  const {rows} = await query(`SELECT m.birth_date,c.allowed,c.revision,c.policy_version FROM members m
    LEFT JOIN intelligence_consent c ON c.organization_id = m.organization_id AND c.user_id = m.id
    WHERE m.organization_id = ? AND m.id = ? LIMIT 1`, [org, user.userId]);
  if (!rows.length) throw new IntelligenceError(404, 'Cadastro não encontrado.');
  const eligible = adultEligibility(rows[0].birth_date);
  return { eligible, allowed: !!Number(rows[0].allowed) && rows[0].policy_version === INTELLIGENCE_VERSION,
    revision: Number(rows[0].revision || 0), policy_version: INTELLIGENCE_VERSION };
}
export async function setUsagePreference(org: string, user: AuthUser, body: any, event: any) {
  if (typeof body.allowed !== 'boolean' || body.policy_version !== INTELLIGENCE_VERSION || !Number.isInteger(body.expected_revision)) throw new IntelligenceError(400, 'Confirme a versão e a escolha de privacidade.');
  const preference = await usagePreference(org, user);
  if (body.allowed && !preference.eligible) throw new IntelligenceError(403, 'Coleta opcional disponível somente a adultos com data de nascimento informada no cadastro.');
  const db = await getConnection();
  try {
    await db.beginTransaction();
    await db.query(`INSERT IGNORE INTO intelligence_consent(organization_id,user_id,allowed,policy_version,revision) VALUES(?,?,0,?,0)`,[org,user.userId,INTELLIGENCE_VERSION]);
    const [rows]:any = await db.query('SELECT revision FROM intelligence_consent WHERE organization_id = ? AND user_id = ? FOR UPDATE',[org,user.userId]);
    if (body.allowed && Number(rows[0].revision) !== body.expected_revision) throw new IntelligenceError(409, 'Sua preferência foi alterada em outra sessão. Atualize antes de autorizar.');
    await db.query('UPDATE intelligence_consent SET allowed = ?, policy_version = ?, revision = revision + 1 WHERE organization_id = ? AND user_id = ?', [body.allowed ? 1 : 0,INTELLIGENCE_VERSION,org,user.userId]);
    if (!body.allowed) {
      const key = subjectKey(org,user.userId);
      await db.query('DELETE FROM intelligence_activity_daily WHERE organization_id = ? AND subject_key = ?',[org,key]);
      await db.query('DELETE FROM intelligence_event_receipts WHERE organization_id = ? AND subject_key = ?',[org,key]);
      // Only events collected through this new policy are deleted here. Legacy source records have a separate retention policy.
      await db.query("DELETE FROM content_engagement_events WHERE organization_id = ? AND user_id = ? AND source = 'PWA_INTELLIGENCE_V1'",[org,user.userId]);
    }
    await logSecurityEvent({organizationId:org,user,action:body.allowed?'USAGE_CONSENT_GRANTED':'USAGE_CONSENT_WITHDRAWN',resource:'intelligence_consent',resourceId:user.userId,
      details:{policyVersion:INTELLIGENCE_VERSION,allowed:body.allowed},event,strict:true,executor:(sql,params)=>db.query(sql,params)});
    await db.commit();
    return {allowed:body.allowed,eligible:preference.eligible,revision:Number(rows[0].revision)+1,policy_version:INTELLIGENCE_VERSION};
  } catch (e) {await db.rollback();throw e;} finally {db.release();}
}
export async function acceptUsage(org: string, campus: string, user: AuthUser, body: any, flags: Record<string,boolean>) {
  if (org !== user.organizationId) throw new IntelligenceError(403,'Coleta permitida apenas na sua própria igreja.');
  if (!flags['intelligence.usage_collection']) throw new IntelligenceError(403,'Coleta de uso pausada nesta igreja.');
  const consent = await usagePreference(org,user);
  if (!consent.allowed || !consent.eligible) throw new IntelligenceError(403,'Coleta de uso não autorizada ou não elegível.');
  const candidates = validateUsageBatch(body.events,flags);
  const events = [];
  // Validate ownership before accepting durable messages. No arbitrary content identifiers enter the pipeline.
  for (const item of candidates) {
    if (item.name === 'content_interaction') {
      const owned = await contentExists(org,item.content_type!,item.content_id!);
      if (!owned.exists || (owned.campusId && owned.campusId !== campus)) continue;
    }
    events.push(item);
  }
  if (!events.length) return {accepted:true,count:0};
  if (!process.env.INTELLIGENCE_QUEUE_URL) throw new IntelligenceError(503,'Medição temporariamente indisponível.');
  await queue.send(new SendMessageCommand({QueueUrl:process.env.INTELLIGENCE_QUEUE_URL,MessageBody:JSON.stringify({
    type:'PWA_USAGE_V1',organization_id:org,campus_id:campus,user_id:user.userId,consent_revision:consent.revision,
    received_at:new Date().toISOString(),events,
  })}));
  return {accepted:true,count:events.length};
}

export async function processUsage(message:any) {
  if (message.type !== 'PWA_USAGE_V1' || !safeIdentifier(message.organization_id) || !safeIdentifier(message.user_id) || !safeIdentifier(message.campus_id) || !Array.isArray(message.events)) throw Error('INVALID_USAGE_MESSAGE');
  const org = String(message.organization_id), campus = String(message.campus_id), userId = String(message.user_id);
  const resolved = await evaluateTenantFlags(org,campus,'production');
  if (!resolved.flags['intelligence.usage_collection']) return;
  // Messages older than the permitted offline window are intentionally discarded, including a redrive from the DLQ.
  if (Date.parse(message.received_at) < Date.now()-86400000) return;
  const candidates = message.events.filter((item:any)=>{
    const moduleFlag = USAGE_MODULE_FLAGS[item?.module];
    if (moduleFlag && !resolved.flags[moduleFlag]) return false;
    const contentFlag = CONTENT_FLAGS[item?.content_type];
    return !contentFlag || !!resolved.flags[contentFlag];
  });
  if (!candidates.length) return;
  const events = validateUsageBatch(candidates,resolved.flags);
  const db = await getConnection();
  try {
    await db.beginTransaction();
    const [consents]:any = await db.query(`SELECT allowed,revision,policy_version,UNIX_TIMESTAMP(updated_at)*1000 AS consent_time FROM intelligence_consent WHERE organization_id = ? AND user_id = ? FOR UPDATE`,[org,userId]);
    const consent = consents[0];
    if (!consent || !Number(consent.allowed) || consent.policy_version !== INTELLIGENCE_VERSION || Number(consent.revision)!==message.consent_revision) {await db.rollback();return;}
    const [members]:any = await db.query(`SELECT role,status,birth_date,cell_group_id,campus_id,campus_ids FROM members WHERE organization_id = ? AND id = ? LIMIT 1`,[org,userId]);
    const member = members[0];
    if (!member || ['INACTIVE','INATIVO','DISABLED','BLOCKED'].includes(String(member.status).toUpperCase()) || !adultEligibility(member.birth_date)) {await db.rollback();return;}
    let campusIds:any = member.campus_ids;
    try {campusIds=typeof campusIds==='string'?JSON.parse(campusIds):campusIds;} catch {campusIds=[];}
    if (!Array.isArray(campusIds) || !campusIds.length) campusIds=[member.campus_id || 'campus_sede'];
    if (!campusIds.includes('all') && !campusIds.includes(campus)) {await db.rollback();return;}
    const [campuses]:any = await db.query('SELECT id FROM campuses WHERE organization_id = ? AND id = ?',[org,campus]);
    if (!campuses.length) {await db.rollback();return;}
    const subject = subjectKey(org,userId);
    const originalRole=String(member.role).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
    const kind = ['VISITOR','VISITANTE'].includes(originalRole)?'visitor':['MEMBER','VOLUNTEER'].includes(normalizeRole(member.role))?'member':'team';
    for (const item of events) {
      const occurred = new Date(item.occurred_at);
      if (occurred.getTime() < Number(consent.consent_time)) continue;
      const at = occurred.toISOString().slice(0,19).replace('T',' ');
      const received = new Date(message.received_at).toISOString().slice(0,19).replace('T',' ');
      const [insert]:any = await db.query(`INSERT IGNORE INTO intelligence_event_receipts(organization_id,event_id,subject_key,occurred_at,received_at) VALUES(?,?,?,?,?)`,[org,item.id,subject,at,received]);
      if (!insert.affectedRows) continue;
      const session = createHash('sha256').update(`${subject}:${item.session_id}`).digest('hex');
      await db.query(`INSERT INTO intelligence_activity_daily(organization_id,campus_id,activity_date,subject_key,session_key,module,experience_version,actor_kind,cell_group_id,interactions,first_at,last_at)
        VALUES(?,?,?,?,?,?,?,?,?,1,?,?) ON DUPLICATE KEY UPDATE interactions=interactions+1,first_at=LEAST(first_at,VALUES(first_at)),last_at=GREATEST(last_at,VALUES(last_at))`,
        [org,campus,dayInSaoPaulo(occurred),subject,session,item.module,item.version,kind,member.cell_group_id||'',at,at]);
      if (item.name === 'content_interaction') {
        // An existing content record can be deleted or moved after enqueueing; the worker rechecks ownership.
        const owned = await contentExists(org,item.content_type!,item.content_id!);
        if (owned.exists && (!owned.campusId || owned.campusId===campus)) {
          await db.query(`INSERT IGNORE INTO content_engagement_events(id,organization_id,campus_id,user_id,session_hash,content_type,content_id,event_type,source,duration_seconds,progress_percent,idempotency_key,occurred_at)
            VALUES(UUID(),?,?,?,?,?,?,?,'PWA_INTELLIGENCE_V1',?,?,?,?)`,
            [org,owned.campusId||campus,userId,session,item.content_type,item.content_id,item.event_type,item.duration_seconds??null,item.progress_percent??null,item.id,at]);
        }
      }
      await db.query(`INSERT INTO intelligence_measurement(organization_id,campus_id,started_at,last_event_at,last_processed_at) VALUES(?,?,?,?,UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE started_at=LEAST(started_at,VALUES(started_at)),last_event_at=GREATEST(last_event_at,VALUES(last_event_at)),last_processed_at=UTC_TIMESTAMP()`,[org,campus,at,at]);
    }
    await db.commit();
  } catch(e) {await db.rollback();throw e;} finally {db.release();}
}
