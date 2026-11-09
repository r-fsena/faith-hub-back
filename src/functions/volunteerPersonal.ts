import { v4 as uuidv4 } from 'uuid';
import { query, getConnection, apiResponse } from '../db';
import { enforcePlanAccess } from '../services/planAccess';
import { logSecurityEvent } from '../services/auditLogService';
import { enforceRole } from '../services/authMiddleware';
import { MinistryScope, MinistryScopeError, requireMinistryAuth, volunteerMember, requireVolunteerMember, campusFilter, assertCampus, scopedMinistry, ministryFailure } from '../services/ministryScope';

type Exec = (sql: string, params?: any[]) => Promise<{ rows: any }>;
const fail = (status: number, error: string, message?: string): never => { throw new MinistryScopeError(apiResponse(status, { error, message })); };
const personal = (feature: string, work: (event: any, scope: MinistryScope) => Promise<any>) => async (event: any) => {
  const plan = await enforcePlanAccess(event, feature); if (plan) return plan;
  try { const scope = await requireMinistryAuth(event); if ('errorResponse' in scope) return scope.errorResponse; const response = await work(event, scope); return { ...response, headers: { ...response.headers, 'Cache-Control': 'no-store, private' } }; }
  catch (error) { return ministryFailure(error); }
};
async function transaction<T>(work: (exec: Exec) => Promise<T>) {
  const connection = await getConnection();
  try { await connection.beginTransaction(); const exec: Exec = async (sql, params = []) => { const [rows] = await connection.query(sql, params); return { rows }; }; const value = await work(exec); await connection.commit(); return value; }
  catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}
async function audit(event: any, scope: MinistryScope, exec: Exec, action: string, resource: string, id: string) {
  await logSecurityEvent({ organizationId: scope.organizationId, campusId: scope.campusId, user: scope.user, action, resource, resourceId: id, event, strict: true, executor: (sql, params) => exec(sql, params) });
}
function participants(member: any) {
  return { sql: ` AND (EXISTS (SELECT 1 FROM ministry_volunteers mv WHERE mv.organization_id = min.organization_id AND mv.ministry_id = min.id AND mv.member_id = ? AND mv.status IN ('ACTIVE','TRAINING')) OR min.leader_id = ? OR (? <> '' AND LOWER(min.leader_id) = ?))`, params: [member.id, member.id, member.email || '', (member.email || '').toLowerCase()] };
}
const scheduleJoins = `FROM service_roster_items sri
  JOIN service_schedules ss ON ss.id = sri.schedule_id AND ss.organization_id = sri.organization_id
  JOIN ministries min ON min.id = ss.ministry_id AND min.organization_id = ss.organization_id AND min.campus_id = ss.campus_id
  JOIN ministry_roles mr ON mr.id = sri.role_id AND mr.organization_id = sri.organization_id AND mr.ministry_id = min.id`;
async function ownRoster(scope: MinistryScope, member: any, id: string, exec: Exec = query, lock = false) {
  const sc = campusFilter(scope, 'ss'), mc = campusFilter(scope, 'min'), participant = participants(member);
  const { rows } = await exec(`SELECT sri.*, ss.campus_id, ss.ministry_id, ss.title AS service_title, ss.service_date, ss.service_time, min.name AS ministry_name
    ${scheduleJoins} WHERE sri.id = ? AND sri.organization_id = ? AND sri.member_id = ? AND ss.status = 'PUBLISHED' AND min.status = 'ACTIVE'
    ${sc.sql}${mc.sql}${participant.sql} LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [id, scope.organizationId, member.id, ...sc.params, ...mc.params, ...participant.params]);
  if (!rows.length) fail(404, 'ROSTER_NOT_FOUND_IN_MEMBER_SCOPE'); return rows[0];
}
export const getMySchedules = personal('volunteers.module_enabled', async (_event, scope) => {
  const member = await volunteerMember(scope); if (!member) return apiResponse(200, []);
  const sc = campusFilter(scope, 'ss'), mc = campusFilter(scope, 'min'), participant = participants(member);
  const { rows } = await query(`SELECT sri.id AS roster_item_id, sri.status AS confirmation_status, sri.decline_reason, sri.confirmed_at,
    ss.id AS schedule_id, ss.organization_id, ss.campus_id, ss.ministry_id, ss.title AS service_title, DATE_FORMAT(ss.service_date,'%Y-%m-%d') AS service_date,
    ss.service_time, ss.notes AS schedule_notes, min.name AS ministry_name, min.color AS ministry_color, min.icon AS ministry_icon, mr.id AS role_id, mr.name AS role_name
    ${scheduleJoins} WHERE sri.organization_id = ? AND sri.member_id = ? AND ss.status = 'PUBLISHED' AND min.status = 'ACTIVE'
    AND ss.service_date >= DATE_SUB(CURDATE(), INTERVAL 2 DAY) ${sc.sql}${mc.sql}${participant.sql}
    ORDER BY ss.service_date ASC, ss.service_time ASC`, [scope.organizationId, member.id, ...sc.params, ...mc.params, ...participant.params]);
  return apiResponse(200, rows);
});
export const respondRosterItem = personal('volunteers.module_enabled', async (event, scope) => {
  const member = await requireVolunteerMember(scope), id = event.pathParameters?.rosterItemId;
  const { status, decline_reason } = JSON.parse(event.body || '{}');
  if (!id || !['ACCEPTED', 'DECLINED'].includes(status)) fail(400, 'INVALID_ROSTER_RESPONSE');
  return transaction(async exec => { const item = await ownRoster(scope, member, id, exec, true); if (item.status === 'SWAP_REQUESTED') fail(409, 'CANCEL_SWAP_BEFORE_RESPONDING');
    await exec('UPDATE service_roster_items SET status = ?, decline_reason = ?, confirmed_at = NOW() WHERE id = ? AND organization_id = ? AND member_id = ?', [status, decline_reason || null, id, scope.organizationId, member.id]);
    await audit(event, scope, exec, 'SERVICE_ROSTER_RESPONDED', 'service_roster_items', id); return apiResponse(200, { message: status === 'ACCEPTED' ? 'Presença confirmada.' : 'Escala recusada.', status }); });
});
export const getMyBlockouts = personal('volunteers.module_enabled', async (_event, scope) => {
  const member = await volunteerMember(scope); if (!member) return apiResponse(200, []);
  const { rows } = await query('SELECT id, organization_id, member_id, start_date, end_date, reason, created_at FROM volunteer_blockouts WHERE organization_id = ? AND member_id = ? ORDER BY start_date DESC', [scope.organizationId, member.id]);
  return apiResponse(200, rows);
});
export const createBlockout = personal('volunteers.module_enabled', async (event, scope) => {
  const member = await requireVolunteerMember(scope), body = JSON.parse(event.body || '{}');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(body.end_date) || body.start_date > body.end_date) fail(400, 'INVALID_BLOCKOUT_DATES');
  const id = uuidv4(); return transaction(async exec => { await exec('INSERT INTO volunteer_blockouts (id, organization_id, member_id, start_date, end_date, reason) VALUES (?,?,?,?,?,?)', [id, scope.organizationId, member.id, body.start_date, body.end_date, body.reason || null]);
    await audit(event, scope, exec, 'VOLUNTEER_BLOCKOUT_CREATED', 'volunteer_blockouts', id); return apiResponse(201, { id, start_date: body.start_date, end_date: body.end_date, reason: body.reason }); });
});
export const deleteBlockout = personal('volunteers.module_enabled', async (event, scope) => {
  const member = await requireVolunteerMember(scope), id = event.pathParameters?.id || event.pathParameters?.blockoutId;
  if (!id) fail(400, 'BLOCKOUT_ID_REQUIRED');
  return transaction(async exec => { const { rows } = await exec('DELETE FROM volunteer_blockouts WHERE id = ? AND organization_id = ? AND member_id = ?', [id, scope.organizationId, member.id]);
    if (!rows.affectedRows) fail(404, 'BLOCKOUT_NOT_FOUND_IN_MEMBER_SCOPE'); await audit(event, scope, exec, 'VOLUNTEER_BLOCKOUT_DELETED', 'volunteer_blockouts', id); return apiResponse(200, { message: 'Indisponibilidade removida.' }); });
});
async function eligiblePeers(scope: MinistryScope, item: any, exec: Exec = query) {
  const { rows } = await exec(`SELECT DISTINCT m.id, m.name FROM ministry_volunteers mv
    JOIN members m ON m.id = mv.member_id AND m.organization_id = mv.organization_id
    JOIN ministry_roles mr ON mr.ministry_id = mv.ministry_id AND mr.organization_id = mv.organization_id
    WHERE mv.organization_id = ? AND mv.ministry_id = ? AND mr.id = ? AND mv.status = 'ACTIVE' AND m.id <> ?
      AND COALESCE(m.status,'ACTIVE') NOT IN ('INACTIVE','INATIVO','DISABLED','BLOCKED')
      AND NOT EXISTS (SELECT 1 FROM volunteer_blockouts vb WHERE vb.organization_id = mv.organization_id AND vb.member_id = m.id AND ? BETWEEN vb.start_date AND vb.end_date)
      AND NOT EXISTS (SELECT 1 FROM service_roster_items r JOIN service_schedules s ON s.id = r.schedule_id AND s.organization_id = r.organization_id WHERE r.organization_id = mv.organization_id AND r.member_id = m.id AND r.status <> 'DECLINED' AND s.status = 'PUBLISHED' AND s.service_date = ? AND (s.id = ? OR s.service_time = ?))
    ORDER BY m.name ASC`, [scope.organizationId, item.ministry_id, item.role_id, item.member_id, item.service_date, item.service_date, item.schedule_id, item.service_time]);
  return rows;
}
export const getEligiblePeersForSwap = personal('volunteers.module_enabled', async (event, scope) => {
  const member = await requireVolunteerMember(scope), q = event.queryStringParameters || {};
  if (!q.schedule_id || !q.role_id) fail(400, 'SCHEDULE_AND_ROLE_REQUIRED');
  const { rows } = await query('SELECT id FROM service_roster_items WHERE organization_id = ? AND schedule_id = ? AND role_id = ? AND member_id = ? LIMIT 1', [scope.organizationId, q.schedule_id, q.role_id, member.id]);
  if (!rows.length) fail(404, 'ROSTER_NOT_FOUND_IN_MEMBER_SCOPE'); const item = await ownRoster(scope, member, rows[0].id);
  return apiResponse(200, await eligiblePeers(scope, item));
});
export const requestRosterSwap = personal('volunteers.module_enabled', async (event, scope) => {
  const member = await requireVolunteerMember(scope), id = event.pathParameters?.rosterItemId, body = JSON.parse(event.body || '{}'); if (!id) fail(400, 'ROSTER_ID_REQUIRED');
  return transaction(async exec => { const item = await ownRoster(scope, member, id, exec, true);
    if (item.status === 'SWAP_REQUESTED' || item.status === 'DECLINED') fail(409, 'ROSTER_NOT_AVAILABLE_FOR_SWAP');
    if (body.target_member_id && !(await eligiblePeers(scope, item, exec)).some((p: any) => p.id === body.target_member_id)) fail(403, 'SUBSTITUTE_NOT_ELIGIBLE_IN_MINISTRY');
    const swapId = uuidv4(); await exec(`INSERT INTO service_roster_swaps (id, organization_id, roster_item_id, schedule_id, role_id, requesting_member_id, target_member_id, reason, status) VALUES (?,?,?,?,?,?,?,?,'PENDING')`, [swapId, scope.organizationId, id, item.schedule_id, item.role_id, member.id, body.target_member_id || null, body.reason || 'Motivo pessoal/imprevisto']);
    await exec("UPDATE service_roster_items SET status = 'SWAP_REQUESTED' WHERE id = ? AND organization_id = ? AND member_id = ?", [id, scope.organizationId, member.id]);
    await audit(event, scope, exec, 'SERVICE_ROSTER_SWAP_REQUESTED', 'service_roster_swaps', swapId); return apiResponse(201, { swap_id: swapId, message: 'Solicitação de troca enviada.' }); });
});
const swapJoins = `FROM service_roster_swaps sw
  JOIN service_roster_items sri ON sri.id = sw.roster_item_id AND sri.organization_id = sw.organization_id AND sri.schedule_id = sw.schedule_id AND sri.role_id = sw.role_id
  JOIN service_schedules ss ON ss.id = sw.schedule_id AND ss.organization_id = sw.organization_id
  JOIN ministries min ON min.id = ss.ministry_id AND min.organization_id = ss.organization_id AND min.campus_id = ss.campus_id
  JOIN ministry_roles mr ON mr.id = sw.role_id AND mr.organization_id = sw.organization_id AND mr.ministry_id = min.id`;
export const getMyPendingSwaps = personal('volunteers.module_enabled', async (_event, scope) => {
  const member = await volunteerMember(scope); if (!member) return apiResponse(200, { incoming: [], outgoing: [] });
  const sc = campusFilter(scope, 'ss'), mc = campusFilter(scope, 'min'), participant = participants(member);
  const common = `sw.organization_id = ? AND ss.status = 'PUBLISHED' AND min.status = 'ACTIVE' ${sc.sql}${mc.sql}`, commonParams = [scope.organizationId, ...sc.params, ...mc.params];
  const fields = `sw.id AS swap_id, sw.organization_id, sw.reason, sw.created_at, sw.status, sw.schedule_id, sw.roster_item_id, ss.campus_id, ss.title AS service_title, ss.service_date, ss.service_time, min.name AS ministry_name, mr.name AS role_name`;
  const { rows: incoming } = await query(`SELECT ${fields}, req.name AS requesting_member_name, req.phone AS requesting_member_phone ${swapJoins}
    JOIN members req ON req.id = sw.requesting_member_id AND req.organization_id = sw.organization_id
    WHERE ${common} AND sw.status = 'PENDING' AND sri.status = 'SWAP_REQUESTED' AND sri.member_id = sw.requesting_member_id AND sw.requesting_member_id <> ?
      AND (sw.target_member_id = ? OR sw.target_member_id IS NULL)
      AND EXISTS (SELECT 1 FROM ministry_volunteers eligible WHERE eligible.organization_id = sw.organization_id AND eligible.ministry_id = min.id AND eligible.member_id = ? AND eligible.status = 'ACTIVE')
    ORDER BY sw.created_at DESC`, [...commonParams, member.id, member.id, member.id]);
  const { rows: outgoing } = await query(`SELECT ${fields}, target.name AS target_member_name ${swapJoins}
    LEFT JOIN members target ON target.id = sw.target_member_id AND target.organization_id = sw.organization_id
    WHERE ${common} AND sw.requesting_member_id = ? ${participant.sql} ORDER BY sw.created_at DESC`, [...commonParams, member.id, ...participant.params]);
  return apiResponse(200, { incoming, outgoing });
});
export const respondToSwap = personal('volunteers.module_enabled', async (event, scope) => {
  const member = await requireVolunteerMember(scope), id = event.pathParameters?.swapId, { action } = JSON.parse(event.body || '{}');
  if (!id || !['ACCEPT', 'REJECT'].includes(action)) fail(400, 'INVALID_SWAP_RESPONSE');
  return transaction(async exec => {
    const { rows } = await exec(`SELECT sw.*, ss.campus_id, ss.ministry_id, ss.service_date, ss.service_time, sri.member_id, sri.status AS roster_status ${swapJoins} WHERE sw.id = ? AND sw.organization_id = ? AND sw.status = 'PENDING' AND ss.status = 'PUBLISHED' AND min.status = 'ACTIVE' LIMIT 1 FOR UPDATE`, [id, scope.organizationId]);
    if (!rows.length) fail(404, 'PENDING_SWAP_NOT_FOUND_IN_ORGANIZATION'); const item = rows[0]; assertCampus(scope, item.campus_id); await scopedMinistry(scope, item.ministry_id);
    if (item.requesting_member_id === member.id || (item.target_member_id && item.target_member_id !== member.id)) fail(403, 'NOT_SWAP_RECIPIENT');
    if (item.member_id !== item.requesting_member_id || item.roster_status !== 'SWAP_REQUESTED') fail(409, 'SWAP_NO_LONGER_AVAILABLE');
    if (!(await eligiblePeers(scope, { ...item, member_id: item.requesting_member_id }, exec)).some((p: any) => p.id === member.id)) fail(403, 'SUBSTITUTE_NOT_ELIGIBLE_IN_MINISTRY');
    if (action === 'ACCEPT') {
      await exec("UPDATE service_roster_items SET member_id = ?, status = 'ACCEPTED', confirmed_at = NOW() WHERE id = ? AND organization_id = ? AND member_id = ? AND status = 'SWAP_REQUESTED'", [member.id, item.roster_item_id, scope.organizationId, item.requesting_member_id]);
      await exec("UPDATE service_roster_swaps SET status = CASE WHEN id = ? THEN 'ACCEPTED' ELSE 'CANCELLED' END, target_member_id = CASE WHEN id = ? THEN ? ELSE target_member_id END, responded_at = NOW() WHERE organization_id = ? AND roster_item_id = ? AND status = 'PENDING'", [id, id, member.id, scope.organizationId, item.roster_item_id]);
      await audit(event, scope, exec, 'SERVICE_ROSTER_SWAP_ACCEPTED', 'service_roster_swaps', id);
    } else if (item.target_member_id === member.id) {
      await exec("UPDATE service_roster_swaps SET status = 'REJECTED', responded_at = NOW() WHERE id = ? AND organization_id = ?", [id, scope.organizationId]);
      await exec("UPDATE service_roster_items SET status = 'ACCEPTED' WHERE id = ? AND organization_id = ? AND member_id = ?", [item.roster_item_id, scope.organizationId, item.requesting_member_id]);
      await audit(event, scope, exec, 'SERVICE_ROSTER_SWAP_REJECTED', 'service_roster_swaps', id);
    }
    return apiResponse(200, { message: action === 'ACCEPT' ? 'Substituição confirmada.' : 'Você optou por não assumir esta vaga.' });
  });
});
export const cancelRosterSwap = personal('volunteers.module_enabled', async (event, scope) => {
  const body = JSON.parse(event.body || '{}'), id = event.pathParameters?.swapId, rosterId = body.rosterItemId || event.pathParameters?.rosterItemId;
  if (!id && !rosterId) fail(400, 'SWAP_OR_ROSTER_ID_REQUIRED');
  const managerRoute = (event.rawPath || event.path || '').startsWith('/ministries/');
  const member = managerRoute ? null : await requireVolunteerMember(scope);
  return transaction(async exec => { const predicate = id ? 'sw.id = ?' : 'sw.roster_item_id = ?';
    const { rows } = await exec(`SELECT sw.*, ss.campus_id, ss.ministry_id, min.leader_id ${swapJoins} WHERE ${predicate} AND sw.organization_id = ? AND sw.status = 'PENDING' ORDER BY sw.created_at DESC LIMIT 1 FOR UPDATE`, [id || rosterId, scope.organizationId]);
    if (!rows.length) fail(404, 'PENDING_SWAP_NOT_FOUND_IN_ORGANIZATION'); const swap = rows[0]; assertCampus(scope, swap.campus_id);
    if (managerRoute) {
      const role = enforceRole(scope.user, ['SUPERADMIN','PASTOR','ADMIN','TREASURER','LEADER']); if (!role.allowed) throw new MinistryScopeError(role.errorResponse!);
      if (swap.ministry_id !== event.pathParameters?.id || swap.schedule_id !== event.pathParameters?.scheduleId) fail(404, 'SWAP_NOT_FOUND_IN_MINISTRY');
      if (!scope.user.isSuperAdmin && !['PASTOR','ADMIN'].includes(scope.user.role) && swap.leader_id !== scope.user.userId) fail(403, 'NOT_MINISTRY_LEADER');
    } else { if (swap.requesting_member_id !== member!.id) fail(403, 'NOT_SWAP_OWNER'); await ownRoster(scope, member, swap.roster_item_id, exec); }
    await exec("UPDATE service_roster_swaps SET status = 'CANCELLED', responded_at = NOW() WHERE organization_id = ? AND roster_item_id = ? AND status = 'PENDING'", [scope.organizationId, swap.roster_item_id]);
    await exec("UPDATE service_roster_items SET status = 'ACCEPTED' WHERE id = ? AND organization_id = ? AND member_id = ? AND status = 'SWAP_REQUESTED'", [swap.roster_item_id, scope.organizationId, swap.requesting_member_id]);
    await audit(event, scope, exec, 'SERVICE_ROSTER_SWAP_CANCELLED', 'service_roster_swaps', swap.id); return apiResponse(200, { message: 'Solicitação de troca cancelada.' }); });
});

export const applyToMinistry = personal('volunteers.module_enabled', async (event, scope) => {
  const member = await requireVolunteerMember(scope), body = JSON.parse(event.body || '{}');
  if (!body.ministry_id) fail(400, 'MINISTRY_ID_REQUIRED');
  const ministry = await scopedMinistry(scope, body.ministry_id);
  if (ministry.status !== 'ACTIVE') fail(403, 'MINISTRY_NOT_OPEN_FOR_APPLICATIONS');
  return transaction(async exec => {
    await exec('SELECT id FROM ministries WHERE organization_id = ? AND id = ? FOR UPDATE', [scope.organizationId, ministry.id]);
    const { rows } = await exec('SELECT id, status FROM ministry_volunteers WHERE organization_id = ? AND ministry_id = ? AND member_id = ? LIMIT 1', [scope.organizationId, ministry.id, member.id]);
    const existing = rows[0], id = existing?.id || uuidv4();
    if (existing && ['ACTIVE', 'TRAINING'].includes(existing.status)) return apiResponse(200, { id, status: existing.status, message: 'Você já faz parte deste ministério.' });
    if (existing) await exec("UPDATE ministry_volunteers SET status = 'CANDIDATE', roles_csv = ?, notes = ?, updated_at = NOW() WHERE id = ? AND organization_id = ? AND member_id = ? AND ministry_id = ?", [body.roles_csv || null, body.notes || null, id, scope.organizationId, member.id, ministry.id]);
    else await exec("INSERT INTO ministry_volunteers (id, organization_id, ministry_id, member_id, status, roles_csv, notes, joined_at) VALUES (?,?,?,?,'CANDIDATE',?,?,CURDATE())", [id, scope.organizationId, ministry.id, member.id, body.roles_csv || null, body.notes || null]);
    await audit(event, scope, exec, 'MINISTRY_SELF_APPLICATION', 'ministry_volunteers', id);
    return apiResponse(201, { id, status: 'CANDIDATE', message: 'Candidatura enviada à liderança desta igreja e unidade.' });
  });
});
