import { createHash } from 'crypto';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { apiResponse, query } from '../db';
import { enforcePermission, enforceRole, enforceTenant, getAuthenticatedUser, requireAuth } from '../services/authMiddleware';
import { evaluateTenantFlags } from '../services/featureFlagService';
import { checkRateLimit } from '../services/rateLimiter';

const ANALYTICS_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER'];
const CONTENT_TYPES = ['EVENT', 'BROADCAST', 'DEVOTIONAL', 'STUDY_BOOK', 'STUDY_CHAPTER'] as const;
const EVENT_TYPES = ['OPENED', 'STARTED', 'COMPLETED', 'CTA_CLICKED', 'NOTE_CREATED', 'STREAM_STARTED', 'STREAM_ENDED'] as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,100}$/;

function isoDate(date: Date): string { return date.toISOString().slice(0, 10); }

function resolvePeriod(event: APIGatewayProxyEvent): { startDate: string; endDate: string } | { error: APIGatewayProxyResult } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startDate = event.queryStringParameters?.start_date || isoDate(start);
  const endDate = event.queryStringParameters?.end_date || isoDate(now);
  if (!DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate)) return { error: apiResponse(400, { message: 'Período inválido. Use AAAA-MM-DD.' }) };
  const days = Math.floor((new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 0 || days > 366) return { error: apiResponse(400, { message: 'Selecione um período entre 1 e 367 dias.' }) };
  return { startDate, endDate };
}

async function contentExists(organizationId: string, contentType: string, contentId: string): Promise<{ exists: boolean; campusId: string | null }> {
  const statements: Record<string, { sql: string; params: any[] }> = {
    EVENT: { sql: 'SELECT id, campus_id FROM events WHERE id = ? AND organization_id = ? LIMIT 1', params: [contentId, organizationId] },
    BROADCAST: { sql: 'SELECT id, campus_id FROM broadcasts WHERE id = ? AND organization_id = ? LIMIT 1', params: [contentId, organizationId] },
    DEVOTIONAL: { sql: 'SELECT id, campus_id FROM devotionals WHERE id = ? AND organization_id = ? LIMIT 1', params: [contentId, organizationId] },
    STUDY_BOOK: { sql: 'SELECT id, campus_id FROM study_books WHERE id = ? AND organization_id = ? LIMIT 1', params: [contentId, organizationId] },
    STUDY_CHAPTER: { sql: `SELECT c.id, b.campus_id FROM study_chapters c INNER JOIN study_books b ON b.id = c.book_id WHERE c.id = ? AND b.organization_id = ? LIMIT 1`, params: [contentId, organizationId] }
  };
  const statement = statements[contentType];
  if (!statement) return { exists: false, campusId: null };
  const { rows } = await query(statement.sql, statement.params);
  return { exists: rows.length > 0, campusId: rows[0]?.campus_id || null };
}

// POST /content/engagement — aceita visitantes, mas nunca confia em tenant, usuário ou conteúdo enviados sem validação.
export const trackContentEngagement = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const rate = await checkRateLimit(event, { maxRequests: 90, windowSeconds: 60, identifierPrefix: 'content_engagement' });
    if (!rate.allowed) return rate.errorResponse!;
    const body = JSON.parse(event.body || '{}');
    const user = await getAuthenticatedUser(event);
    const organizationId = String(body.organization_id || user?.organizationId || '');
    if (!organizationId || !SAFE_ID.test(organizationId)) return apiResponse(400, { message: 'Organização inválida.' });
    if (user) {
      const tenant = enforceTenant(user, organizationId);
      if (!tenant.allowed) return tenant.errorResponse!;
    }

    const contentType = String(body.content_type || '').toUpperCase();
    const eventType = String(body.event_type || '').toUpperCase();
    const contentId = String(body.content_id || '');
    const idempotencyKey = String(body.idempotency_key || '');
    if (!(CONTENT_TYPES as readonly string[]).includes(contentType) || !(EVENT_TYPES as readonly string[]).includes(eventType)) return apiResponse(400, { message: 'Tipo de conteúdo ou interação inválido.' });
    if (!SAFE_ID.test(contentId) || !SAFE_ID.test(idempotencyKey)) return apiResponse(400, { message: 'Identificadores inválidos.' });

    const flags = await evaluateTenantFlags(organizationId, body.campus_id || null, 'production');
    if (!flags.flags['content.analytics_dashboard']) return apiResponse(403, { error: 'FEATURE_DISABLED', message: 'A inteligência de conteúdo não está habilitada.' });

    const ownedContent = await contentExists(organizationId, contentType, contentId);
    if (!ownedContent.exists) return apiResponse(404, { message: 'Conteúdo não encontrado nesta organização.' });
    const requestedCampus = body.campus_id && body.campus_id !== 'all' ? String(body.campus_id) : null;
    if (requestedCampus) {
      const campus = await query('SELECT id FROM campuses WHERE id = ? AND organization_id = ? AND status = \'ACTIVE\' LIMIT 1', [requestedCampus, organizationId]);
      if (!campus.rows.length) return apiResponse(403, { message: 'Unidade fora da organização.' });
    }
    if (requestedCampus && ownedContent.campusId && requestedCampus !== ownedContent.campusId) return apiResponse(403, { message: 'Conteúdo fora da unidade informada.' });

    const sessionId = String(body.session_id || '');
    if (!user && !SAFE_ID.test(sessionId)) return apiResponse(400, { message: 'Sessão anônima inválida.' });
    const sessionHash = sessionId ? createHash('sha256').update(`${organizationId}:${sessionId}`).digest('hex') : null;
    const duration = Number(body.duration_seconds);
    const progress = Number(body.progress_percent);
    const occurredAt = body.occurred_at && !Number.isNaN(Date.parse(body.occurred_at)) ? new Date(body.occurred_at) : new Date();
    if (occurredAt.getTime() > Date.now() + 300_000 || occurredAt.getTime() < Date.now() - 7 * 86_400_000) return apiResponse(400, { message: 'Data da interação fora da janela permitida.' });

    await query(`INSERT IGNORE INTO content_engagement_events
      (id, organization_id, campus_id, user_id, session_hash, content_type, content_id, event_type, source,
       duration_seconds, progress_percent, idempotency_key, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      uuidv4(), organizationId, ownedContent.campusId || requestedCampus, user?.userId || null, sessionHash,
      contentType, contentId, eventType, body.source ? String(body.source).slice(0, 64) : 'PWA',
      Number.isFinite(duration) ? Math.max(0, Math.min(86_400, Math.round(duration))) : null,
      Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null,
      idempotencyKey, occurredAt
    ]);
    return apiResponse(202, { accepted: true });
  } catch (error) {
    console.error('Erro registrando engajamento de conteúdo:', error);
    return apiResponse(500, { message: 'Não foi possível registrar a interação.' });
  }
};

// GET /content/analytics
export const getContentAnalytics = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;
    const role = enforceRole(auth.user, ANALYTICS_ROLES);
    if (!role.allowed) return role.errorResponse!;
    const permission = enforcePermission(auth.user, 'content.analytics.view', ['SUPERADMIN', 'PASTOR', 'ADMIN']);
    if (!permission.allowed) return permission.errorResponse!;
    const tenant = enforceTenant(auth.user, event.queryStringParameters?.organization_id);
    if (!tenant.allowed) return tenant.errorResponse!;
    const organizationId = tenant.effectiveOrgId;
    const campusId = event.queryStringParameters?.campus_id;
    const scopedCampus = campusId && campusId !== 'all' ? campusId : null;
    const period = resolvePeriod(event);
    if ('error' in period) return period.error;
    const flags = await evaluateTenantFlags(organizationId, scopedCampus, 'production');
    if (!flags.flags['content.analytics_dashboard']) return apiResponse(403, { error: 'FEATURE_DISABLED', message: 'A inteligência de conteúdo não está habilitada.' });

    const dateFilter = `occurred_at >= ? AND occurred_at < DATE_ADD(?, INTERVAL 1 DAY)`;
    const campusFilter = scopedCampus ? ' AND campus_id = ?' : '';
    const params = [organizationId, period.startDate, period.endDate, ...(scopedCampus ? [scopedCampus] : [])];
    const contentCampus = scopedCampus ? ' AND (campus_id = ? OR campus_id IS NULL)' : '';
    const contentParams = [organizationId, ...(scopedCampus ? [scopedCampus] : [])];

    // Consultas sequenciais protegem o pool do RDS em aberturas simultâneas do Studio.
    const engagement = await query(`SELECT
      COUNT(*) AS interactions,
      COUNT(DISTINCT COALESCE(user_id, session_hash)) AS engaged_users,
      SUM(event_type = 'OPENED') AS opens,
      SUM(event_type = 'STARTED' OR event_type = 'STREAM_STARTED') AS starts,
      SUM(event_type = 'COMPLETED') AS completions,
      SUM(event_type = 'NOTE_CREATED') AS notes
      FROM content_engagement_events WHERE organization_id = ? AND ${dateFilter}${campusFilter}`, params);
    const byModule = await query(`SELECT content_type, COUNT(*) AS interactions,
      COUNT(DISTINCT COALESCE(user_id, session_hash)) AS users,
      SUM(event_type = 'OPENED') AS opens,
      SUM(event_type = 'STARTED' OR event_type = 'STREAM_STARTED') AS starts,
      SUM(event_type = 'COMPLETED') AS completions,
      SUM(event_type = 'CTA_CLICKED') AS cta_clicks,
      SUM(event_type = 'NOTE_CREATED') AS notes
      FROM content_engagement_events WHERE organization_id = ? AND ${dateFilter}${campusFilter}
      GROUP BY content_type`, params);
    const daily = await query(`SELECT DATE_FORMAT(occurred_at, '%Y-%m-%d') AS activity_date,
      COUNT(*) AS interactions, COUNT(DISTINCT COALESCE(user_id, session_hash)) AS users,
      SUM(event_type = 'COMPLETED') AS completions
      FROM content_engagement_events WHERE organization_id = ? AND ${dateFilter}${campusFilter}
      GROUP BY activity_date ORDER BY activity_date`, params);
    const published = await query(`SELECT
      (SELECT COUNT(*) FROM events WHERE organization_id = ? AND status = 'PUBLISHED'${contentCampus}) AS events,
      (SELECT COUNT(*) FROM broadcasts WHERE organization_id = ? AND is_available = 1${contentCampus}) AS broadcasts,
      (SELECT COUNT(*) FROM devotionals WHERE organization_id = ? AND status = 'PUBLISHED'${contentCampus}) AS devotionals,
      (SELECT COUNT(*) FROM study_books WHERE organization_id = ? AND status = 'ACTIVE'${contentCampus}) AS studies`, [
      ...contentParams, ...contentParams, ...contentParams, ...contentParams
    ]);
    const eventStats = await query(`SELECT COUNT(DISTINCT e.id) AS published,
      COUNT(DISTINCT CASE WHEN e.start_date >= NOW() THEN e.id END) AS upcoming,
      COUNT(DISTINCT CASE WHEN t.status IN ('PAID','USED') THEN t.id END) AS registrations,
      COUNT(DISTINCT CASE WHEN t.status = 'USED' THEN t.id END) AS checkins,
      COALESCE(SUM(CASE WHEN t.status IN ('PAID','USED') THEN t.price_paid ELSE 0 END), 0) AS revenue
      FROM events e LEFT JOIN event_tickets t ON t.event_id = e.id AND t.organization_id = e.organization_id
        AND t.created_at >= ? AND t.created_at < DATE_ADD(?, INTERVAL 1 DAY)
      WHERE e.organization_id = ? AND e.status = 'PUBLISHED'${contentCampus}`, [period.startDate, period.endDate, ...contentParams]);
    const eventCapacity = await query(`SELECT COALESCE(SUM(l.total_capacity), 0) AS capacity
      FROM event_lots l INNER JOIN events e ON e.id = l.event_id
      WHERE e.organization_id = ? AND e.status = 'PUBLISHED'${scopedCampus ? ' AND (e.campus_id = ? OR e.campus_id IS NULL)' : ''}`, contentParams);
    const devotionalStats = await query(`SELECT COUNT(DISTINCT d.id) AS published,
      COUNT(DISTINCT d.available_date) AS calendar_days,
      COUNT(DISTINCT n.id) AS notes
      FROM devotionals d LEFT JOIN devotional_notes n ON n.devotional_id = d.id
        AND n.created_at >= ? AND n.created_at < DATE_ADD(?, INTERVAL 1 DAY)
      WHERE d.organization_id = ? AND d.status = 'PUBLISHED'${scopedCampus ? ' AND (d.campus_id = ? OR d.campus_id IS NULL)' : ''}`, [period.startDate, period.endDate, ...contentParams]);
    const studyStats = await query(`SELECT COUNT(DISTINCT b.id) AS active_series, COUNT(DISTINCT c.id) AS chapters,
      COUNT(DISTINCT sc.user_id) AS participants, COUNT(DISTINCT sc.id) AS completed_chapters
      FROM study_books b LEFT JOIN study_chapters c ON c.book_id = b.id AND c.status = 'ACTIVE'
      LEFT JOIN study_chapter_completions sc ON sc.chapter_id = c.id AND sc.organization_id = b.organization_id
        AND sc.completed_at >= ? AND sc.completed_at < DATE_ADD(?, INTERVAL 1 DAY)
      WHERE b.organization_id = ? AND b.status = 'ACTIVE'${scopedCampus ? ' AND (b.campus_id = ? OR b.campus_id IS NULL)' : ''}`, [period.startDate, period.endDate, ...contentParams]);
    const topContent = await query(`SELECT content_type, content_id, COUNT(*) AS interactions,
      COUNT(DISTINCT COALESCE(user_id, session_hash)) AS users,
      SUM(event_type = 'COMPLETED') AS completions
      FROM content_engagement_events WHERE organization_id = ? AND ${dateFilter}${campusFilter}
      GROUP BY content_type, content_id ORDER BY interactions DESC LIMIT 10`, params);

    const moduleRows = Object.fromEntries(byModule.rows.map((row: any) => [row.content_type, row]));
    const summary = engagement.rows[0] || {};
    const publication = published.rows[0] || {};
    const publishedTotal = Number(publication.events || 0) + Number(publication.broadcasts || 0) + Number(publication.devotionals || 0) + Number(publication.studies || 0);
    return apiResponse(200, {
      period: { start_date: period.startDate, end_date: period.endDate },
      measurement: { behavioral_tracking_started_at: '2026-10-28', bible_included: false, zero_means: 'Nenhuma ocorrência registrada no período após o início da medição.' },
      summary: { published_content: publishedTotal, engaged_users: Number(summary.engaged_users || 0), interactions: Number(summary.interactions || 0), completions: Number(summary.completions || 0) },
      events: { ...eventStats.rows[0], capacity: Number(eventCapacity.rows[0]?.capacity || 0), ...moduleRows.EVENT, measured: true },
      broadcasts: { published: Number(publication.broadcasts || 0), ...moduleRows.BROADCAST, measured: true },
      devotionals: { ...devotionalStats.rows[0], ...moduleRows.DEVOTIONAL, measured: true },
      studies: { ...studyStats.rows[0], book_engagement: moduleRows.STUDY_BOOK || {}, chapter_engagement: moduleRows.STUDY_CHAPTER || {}, measured: true },
      activity_by_day: daily.rows,
      top_content: topContent.rows
    });
  } catch (error) {
    console.error('Erro carregando inteligência de Conteúdo & Comunicação:', error);
    return apiResponse(500, { message: 'Não foi possível carregar os indicadores de conteúdo.' });
  }
};
