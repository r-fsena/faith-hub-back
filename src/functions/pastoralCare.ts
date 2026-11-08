import {privateWelcomeEndpoint,createWelcomeVisitor} from '../services/intelligenceWelcomeLegacy';
import { intelligenceScope, scopedWhere } from '../services/intelligenceScope';
import { evaluateTenantFlags } from '../services/featureFlagService';
import { enforcePlanAccess } from '../services/planAccess';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';
import { checkRateLimit } from '../services/rateLimiter';

const PASTORAL_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER'];

// GET /pastoral/absenteeism-radar -> Radar de Ausências e Evasão
export const getAbsenteeismRadar = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'pastoral.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, PASTORAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const requestedOrgId = event.queryStringParameters?.organization_id;
    const campusId = event.queryStringParameters?.campus_id;
    const cellGroupId = event.queryStringParameters?.cell_group_id;
    const filterTier = event.queryStringParameters?.tier; // 'ALL', 'CRITICAL', 'ATTENTION', 'HEALTHY'

    const tenantCheck = enforceTenant(auth.user, requestedOrgId);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgId = tenantCheck.effectiveOrgId;

    // 1. Buscar membros ativos que pertencem a células com métricas de presença calculadas
    let sql = `
      SELECT 
        m.id,
        m.name,
        m.phone,
        m.email,
        m.role,
        m.created_at as member_since,
        cg.id as cell_id,
        cg.name as cell_name,
        cg.meeting_day,
        cg.meeting_time,
        cg.neighborhood as cell_neighborhood,
        leader.name as leader_name,
        leader.phone as leader_phone,
        (
          SELECT MAX(cm.meeting_date)
          FROM cell_meeting_attendees cma
          INNER JOIN cell_meetings cm ON cma.meeting_id = cm.id
          WHERE cma.member_id = m.id AND cma.status = 'PRESENT'
        ) as last_present_date,
        (
          SELECT COUNT(*)
          FROM cell_meeting_attendees cma
          WHERE cma.member_id = m.id AND cma.status = 'PRESENT'
        ) as total_presences,
        (
          SELECT pcl.created_at
          FROM pastoral_care_logs pcl
          WHERE pcl.member_id = m.id
          ORDER BY pcl.created_at DESC
          LIMIT 1
        ) as last_care_date,
        (
          SELECT pcl.contact_type
          FROM pastoral_care_logs pcl
          WHERE pcl.member_id = m.id
          ORDER BY pcl.created_at DESC
          LIMIT 1
        ) as last_care_type,
        (
          SELECT pcl.summary
          FROM pastoral_care_logs pcl
          WHERE pcl.member_id = m.id
          ORDER BY pcl.created_at DESC
          LIMIT 1
        ) as last_care_summary,
        (
          SELECT pcl.caregiver_name
          FROM pastoral_care_logs pcl
          WHERE pcl.member_id = m.id
          ORDER BY pcl.created_at DESC
          LIMIT 1
        ) as last_caregiver_name
      FROM members m
      INNER JOIN cell_groups cg ON m.cell_group_id = cg.id
      LEFT JOIN members leader ON cg.leader_id = leader.id
      WHERE m.organization_id = ?
        AND m.status = 'ACTIVE'
    `;

    const params: any[] = [orgId];

    if (campusId && campusId !== 'all') {
      sql += ` AND (cg.campus_id = ? OR cg.campus_id IS NULL)`;
      params.push(campusId);
    }

    if (cellGroupId && cellGroupId !== 'all') {
      sql += ` AND cg.id = ?`;
      params.push(cellGroupId);
    }

    sql += ` ORDER BY m.name ASC`;

    const { rows } = await query(sql, params);

    const now = new Date();
    let criticalCount = 0;
    let attentionCount = 0;
    let healthyCount = 0;

    const radarList = rows.map((row: any) => {
      let weeksAbsent = 0;
      let daysAbsent = 0;
      let neverAttended = false;

      if (row.last_present_date) {
        const lastDate = new Date(row.last_present_date);
        const diffTime = Math.max(0, now.getTime() - lastDate.getTime());
        daysAbsent = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        weeksAbsent = Math.floor(daysAbsent / 7);
      } else {
        // Nunca teve presença registrada em reunião cadastrada
        neverAttended = true;
        const regDate = new Date(row.member_since);
        const diffTime = Math.max(0, now.getTime() - regDate.getTime());
        daysAbsent = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        weeksAbsent = Math.min(12, Math.floor(daysAbsent / 7)); // Cap em 12 semanas para não inflar absurdamente
      }

      let riskTier: 'HEALTHY' | 'ATTENTION' | 'CRITICAL' = 'HEALTHY';
      if (weeksAbsent >= 4) {
        riskTier = 'CRITICAL';
        criticalCount++;
      } else if (weeksAbsent >= 2) {
        riskTier = 'ATTENTION';
        attentionCount++;
      } else {
        riskTier = 'HEALTHY';
        healthyCount++;
      }

      return {
        ...row,
        weeks_absent: weeksAbsent,
        days_absent: daysAbsent,
        never_attended: neverAttended,
        risk_tier: riskTier
      };
    });

    // Ordenar pelo mais crítico (maior tempo sem comparecer primeiro)
    radarList.sort((a: any, b: any) => {
      if (a.weeks_absent !== b.weeks_absent) {
        return b.weeks_absent - a.weeks_absent;
      }
      return a.name.localeCompare(b.name);
    });

    // Filtro por Tier se solicitado
    const filteredList = filterTier && filterTier !== 'ALL' 
      ? radarList.filter((item: any) => item.risk_tier === filterTier)
      : radarList;

    // Buscar contatos realizados no mês corrente
    const { rows: careStats } = await query(`
      SELECT COUNT(*) as care_count 
      FROM pastoral_care_logs 
      WHERE organization_id = ? 
        AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')
    `, [orgId]);

    const contactsThisMonth = careStats[0]?.care_count || 0;

    return apiResponse(200, {
      summary: {
        total_cell_members: radarList.length,
        critical_count: criticalCount,
        attention_count: attentionCount,
        healthy_count: healthyCount,
        contacts_this_month: contactsThisMonth
      },
      members: filteredList
    });
  } catch (err: any) {
    console.error('Erro ao gerar radar pastoral:', err);
    return apiResponse(500, { error: 'Erro ao gerar radar de ausências' });
  }
};

// POST /pastoral/care-logs -> Registrar contato ou acompanhamento pastoral
export const createCareLog = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'pastoral.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, PASTORAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const { 
      member_id, 
      campus_id, 
      contact_type = 'WHATSAPP', 
      summary, 
      scheduled_follow_up 
    } = body;

    if (!member_id || !summary) {
      return apiResponse(400, { error: 'member_id e summary (anotação) são obrigatórios' });
    }

    const { rows: memberRows } = await query(`SELECT organization_id, name FROM members WHERE id = ? LIMIT 1`, [member_id]);
    if (memberRows.length === 0) return apiResponse(404, { error: 'Membro não encontrado' });

    const tenantCheck = enforceTenant(auth.user, memberRows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    const logId = uuidv4();
    const caregiverName = auth.user.name || auth.user.email || 'Liderança Pastoral';

    await query(`
      INSERT INTO pastoral_care_logs 
      (id, organization_id, campus_id, member_id, caregiver_id, caregiver_name, contact_type, summary, scheduled_follow_up)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      logId,
      tenantCheck.effectiveOrgId,
      campus_id || null,
      member_id,
      auth.user.userId || 'usr_pastor',
      caregiverName,
      contact_type,
      summary,
      scheduled_follow_up || null
    ]);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'PASTORAL_CARE_CONTACT',
      resource: 'pastoral_care_logs',
      resourceId: logId,
      details: { 
        member_name: memberRows[0].name, 
        contact_type, 
        caregiver_name: caregiverName 
      },
      event
    });

    return apiResponse(201, {
      message: 'Acompanhamento pastoral registrado com sucesso!',
      id: logId,
      created_at: new Date().toISOString()
    });
  } catch (err: any) {
    console.error('Erro ao registrar cuidado pastoral:', err);
    return apiResponse(500, { error: 'Erro ao registrar contato pastoral' });
  }
};

// GET /pastoral/care-logs/{memberId} -> Histórico de contatos com o membro
export const getMemberCareLogs = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'pastoral.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, PASTORAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const memberId = event.pathParameters?.memberId;
    if (!memberId) return apiResponse(400, { error: 'memberId ausente' });

    const { rows: memberRows } = await query(`SELECT organization_id, name FROM members WHERE id = ? LIMIT 1`, [memberId]);
    if (memberRows.length === 0) return apiResponse(404, { error: 'Membro não encontrado' });

    const tenantCheck = enforceTenant(auth.user, memberRows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    const { rows } = await query(`
      SELECT * 
      FROM pastoral_care_logs 
      WHERE member_id = ? AND organization_id = ?
      ORDER BY created_at DESC
    `, [memberId, tenantCheck.effectiveOrgId]);

    return apiResponse(200, rows);
  } catch (err: any) {
    console.error('Erro ao listar logs pastorais:', err);
    return apiResponse(500, { error: 'Erro ao consultar histórico de cuidado' });
  }
};

// ==========================================
// FUNIL DE VISITANTES & CRM DE ACOLHIMENTO
// ==========================================

// GET /pastoral/visitors -> Listar visitantes com status, dias e célula vinculada
export const listVisitors = async (event: any): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'visitors.module_enabled');
  if (planAccess) return planAccess;
  return privateWelcomeEndpoint(event,'list');
};

export const registerVisitor = async (event: any): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'visitors.module_enabled');
  if (planAccess) return planAccess;
  return createWelcomeVisitor(event);
};

export const updateVisitorStage = async (event: any): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'visitors.module_enabled');
  if (planAccess) return planAccess;
  return privateWelcomeEndpoint(event,'stage');
};

export const referVisitorToCell = async (event: any): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'visitors.module_enabled');
  if (planAccess) return planAccess;
  return privateWelcomeEndpoint(event,'refer');
};

export const deleteVisitor = async (event: any): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'visitors.module_enabled');
  if (planAccess) return planAccess;
  return privateWelcomeEndpoint(event,'archive');
};

export const getExecutiveReport = async (event: any): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'pastoral.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireAuth(event);if ('errorResponse' in auth) return auth.errorResponse;
    const roleCheck = enforceRole(auth.user, PASTORAL_ROLES);if (!roleCheck.allowed) return roleCheck.errorResponse!;
    const scope = await intelligenceScope(event, auth.user);if ('statusCode' in scope) return scope;
    const orgId = scope.organizationId,flags = (await evaluateTenantFlags(orgId,scope.campusId,'production')).flags;
    const visitors = scopedWhere(scope,'v','campus_id','assigned_cell_id'),cells = scopedWhere(scope,'cg','campus_id','id');
    const care = scopedWhere({...scope,cellIds:null},'pcl');
    const {rows:visitorMetrics} = flags['visitors.module_enabled'] ? await query(`SELECT COUNT(*) AS total_visitors,
      SUM(v.stage = 'NEW') AS stage_new,SUM(v.stage = 'CONTACTED_24H') AS stage_contacted,
      SUM(v.stage = 'REFERRED_TO_CELL') AS stage_referred,SUM(v.stage = 'ATTENDING_CELL') AS stage_attending,
      SUM(v.stage = 'INTEGRATED_MEMBER') AS stage_integrated FROM church_visitors v
      WHERE v.organization_id = ? AND v.created_at >= DATE_SUB(CURRENT_DATE,INTERVAL 90 DAY)${visitors.sql}`,[orgId,...visitors.params]) : {rows:[]};
    const {rows:cellHealth} = flags['cell_groups.module_enabled'] ? await query(`SELECT cg.id,cg.name,cg.meeting_day,cg.neighborhood,
      leader.name AS leader_name,COUNT(DISTINCT m.id) AS total_members,
      (SELECT COUNT(*) FROM cell_meeting_attendees cma INNER JOIN cell_meetings cm ON cm.organization_id = cma.organization_id AND cm.id = cma.meeting_id
       WHERE cma.organization_id = cg.organization_id AND cm.cell_group_id = cg.id AND COALESCE(cm.campus_id,'campus_sede') = COALESCE(cg.campus_id,'campus_sede')
       AND cma.status = 'PRESENT' AND cm.meeting_date >= DATE_SUB(CURRENT_DATE,INTERVAL 30 DAY)) AS total_attendances_30d,
      (SELECT COUNT(*) FROM cell_meetings cm2 WHERE cm2.organization_id = cg.organization_id AND cm2.cell_group_id = cg.id
       AND COALESCE(cm2.campus_id,'campus_sede') = COALESCE(cg.campus_id,'campus_sede') AND cm2.meeting_date >= DATE_SUB(CURRENT_DATE,INTERVAL 30 DAY)) AS meetings_count_30d
      FROM cell_groups cg LEFT JOIN members leader ON leader.organization_id = cg.organization_id AND leader.id = cg.leader_id
      LEFT JOIN members m ON m.organization_id = cg.organization_id AND m.cell_group_id = cg.id AND UPPER(m.status) IN ('ACTIVE','ATIVO')
      WHERE cg.organization_id = ?${cells.sql} GROUP BY cg.id ORDER BY total_members DESC LIMIT 200`,[orgId,...cells.params]) : {rows:[]};
    const {rows:careMetrics} = await query(`SELECT pcl.contact_type,COUNT(*) AS count FROM pastoral_care_logs pcl
      WHERE pcl.organization_id = ? AND pcl.created_at >= DATE_SUB(CURRENT_DATE,INTERVAL 30 DAY)${care.sql}${scope.cellIds?' AND pcl.caregiver_id = ?':''}
      GROUP BY pcl.contact_type`,[orgId,...care.params,...(scope.cellIds?[scope.user.userId]:[])]);
    return apiResponse(200,{visitor_funnel:visitorMetrics[0]||{},cell_rankings:cellHealth,care_metrics:careMetrics,
      coverage:'registered_records_only',note:'Etapas atuais e registros lançados; não representam conversão por coorte nem ausência presumida.'},{'Cache-Control':'no-store'});
  }catch{return apiResponse(503,{error:'Não foi possível consultar as fontes autorizadas.'});}
};

// GET /pastoral/members/{id}/timeline -> Prontuário 360º pastoral do membro
export const getMemberTimeline360 = async (event: any): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'pastoral.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, PASTORAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const scope = await intelligenceScope(event, auth.user);
    if ('statusCode' in scope) return scope;
    const memberFilter = scopedWhere(scope, 'm', 'campus_id', 'cell_group_id');
    const meetingFilter = scopedWhere(scope, 'cm', 'campus_id', 'cell_group_id');
    const careFilter = scopedWhere({...scope,cellIds:null}, 'pcl');
    const ministryFilter = scopedWhere({...scope,cellIds:null}, 'ss');
    const features = await evaluateTenantFlags(scope.organizationId, scope.campusId, 'production');
    const memberId = event.pathParameters?.id || event.pathParameters?.memberId;
    if (!memberId) return apiResponse(400, { error: 'ID do membro ausente' });

    const { rows: memRows } = await query(`
      SELECT 
        m.id, m.name, m.phone, m.email, m.role, m.created_at, m.status,
        cg.name as cell_name, leader.name as leader_name, leader.phone as leader_phone
      FROM members m
      LEFT JOIN cell_groups cg ON m.cell_group_id = cg.id AND cg.organization_id = m.organization_id
      LEFT JOIN members leader ON cg.leader_id = leader.id AND leader.organization_id = m.organization_id
      WHERE m.id = ? AND m.organization_id = ?${memberFilter.sql} LIMIT 1
    `, [memberId, scope.organizationId, ...memberFilter.params]);

    if (memRows.length === 0) return apiResponse(404, { error: 'Membro não encontrado' });
    const member = memRows[0];

    // Presenças nas reuniões de célula
    const { rows: meetings } = await query(`
      SELECT cm.meeting_date, cm.study_topic, cma.status as attendance_status, cma.justification
      FROM cell_meeting_attendees cma
      INNER JOIN cell_meetings cm ON cma.meeting_id = cm.id AND cm.organization_id = cma.organization_id
      WHERE cma.member_id = ? AND cma.organization_id = ?${meetingFilter.sql}
      ORDER BY cm.meeting_date DESC
      LIMIT 12
    `, [memberId, scope.organizationId, ...meetingFilter.params]);

    // Histórico de cuidados pastorais
    const { rows: careLogs } = await query(`
      SELECT id, caregiver_name, contact_type, summary, scheduled_follow_up, created_at
      FROM pastoral_care_logs pcl
      WHERE pcl.member_id = ? AND pcl.organization_id = ?${careFilter.sql}${auth.user.role === 'LEADER' ? ' AND pcl.caregiver_id = ?' : ''}
      ORDER BY created_at DESC
    `, [memberId, scope.organizationId, ...careFilter.params, ...(auth.user.role === 'LEADER' ? [auth.user.userId] : [])]);

    // Ministérios e escalas
    const { rows: ministries } = features.flags['ministries.module_enabled'] ? await query(`
      SELECT 
        m.name as ministry_name,
        mr.name as role_name,
        sri.status as confirmation_status,
        ss.title as service_title,
        ss.service_date,
        ss.service_time
      FROM service_roster_items sri
      INNER JOIN service_schedules ss ON sri.schedule_id = ss.id AND ss.organization_id = sri.organization_id
      INNER JOIN ministries m ON ss.ministry_id = m.id AND m.organization_id = ss.organization_id
      INNER JOIN ministry_roles mr ON sri.role_id = mr.id AND mr.organization_id = sri.organization_id
      WHERE sri.member_id = ? AND sri.organization_id = ?${ministryFilter.sql}
      ORDER BY ss.service_date DESC
      LIMIT 10
    `, [memberId, scope.organizationId, ...ministryFilter.params]) : { rows: [] };

    await logSecurityEvent({organizationId:scope.organizationId,campusId:scope.campusId,user:auth.user,action:'VIEW_PASTORAL_TIMELINE',resource:'members',resourceId:memberId,event,strict:true});
    return apiResponse(200, {
      member,
      meetings,
      careLogs,
      ministries
    });
  } catch (err: any) {
    console.error('Erro ao buscar prontuário 360 do membro:', err);
    return apiResponse(500, { error: 'Erro ao consultar prontuário do membro' });
  }
};

// GET /pastoral/pending-cell-reports -> Células sem chamada de presença nos últimos 7 dias
export const getPendingCellReports = async (event: any): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'pastoral.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, PASTORAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const qp = event.queryStringParameters || {};
    const tenantCheck = enforceTenant(auth.user, qp.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgId = tenantCheck.effectiveOrgId;
    const campusId = qp.campus_id;

    let sql = `
      SELECT 
        cg.id as cell_id,
        cg.name as cell_name,
        cg.meeting_day,
        cg.meeting_time,
        cg.neighborhood,
        cg.campus_id,
        leader.id as leader_id,
        leader.name as leader_name,
        leader.phone as leader_phone,
        leader.email as leader_email,
        (
          SELECT MAX(cm.meeting_date) 
          FROM cell_meetings cm 
          WHERE cm.cell_group_id = cg.id
        ) as last_meeting_date,
        DATEDIFF(CURRENT_DATE, (
          SELECT MAX(cm.meeting_date) 
          FROM cell_meetings cm 
          WHERE cm.cell_group_id = cg.id
        )) as days_since_last_meeting
      FROM cell_groups cg
      INNER JOIN members leader ON cg.leader_id = leader.id
      WHERE cg.organization_id = ?
        AND (
          NOT EXISTS (
            SELECT 1 FROM cell_meetings cm 
            WHERE cm.cell_group_id = cg.id 
              AND cm.meeting_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
          )
        )
    `;
    const params: any[] = [orgId];
    if (campusId && campusId !== 'all') {
      sql += ` AND cg.campus_id = ?`;
      params.push(campusId);
    }

    sql += ` ORDER BY days_since_last_meeting DESC`;

    const { rows } = await query(sql, params);
    return apiResponse(200, rows);
  } catch (err: any) {
    console.error('Erro ao consultar relatórios de células pendentes:', err);
    return apiResponse(500, { error: 'Erro ao consultar relatórios pendentes de células' });
  }
};

// POST /pastoral/remind-cell-leaders -> Gera lembretes WhatsApp para líderes pendentes
export const remindCellLeaders = async (event: any): Promise<APIGatewayProxyResult> => {
  const planAccess = await enforcePlanAccess(event, 'pastoral.module_enabled');
  if (planAccess) return planAccess;
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, PASTORAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const tenantCheck = enforceTenant(auth.user, body.organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgId = tenantCheck.effectiveOrgId;

    const { rows } = await query(`
      SELECT 
        cg.id as cell_id,
        cg.name as cell_name,
        cg.meeting_day,
        leader.name as leader_name,
        leader.phone as leader_phone
      FROM cell_groups cg
      INNER JOIN members leader ON cg.leader_id = leader.id
      WHERE cg.organization_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM cell_meetings cm 
          WHERE cm.cell_group_id = cg.id 
            AND cm.meeting_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
        )
    `, [orgId]);

    const reminders = rows.map((r: any) => {
      const cleanPhone = (r.leader_phone || '').replace(/\D/g, '');
      const text = `Paz do Senhor, Líder ${r.leader_name}! 🕊️ Passando para lembrar de registrar o relatório e a lista de presença da reunião da sua célula (${r.cell_name}) no aplicativo Faith-Hub. Seu envio é fundamental para o acompanhamento pastoral dos membros! Deus abençoe!`;
      return {
        cell_id: r.cell_id,
        cell_name: r.cell_name,
        leader_name: r.leader_name,
        leader_phone: r.leader_phone,
        whatsapp_url: cleanPhone ? `https://wa.me/55${cleanPhone}?text=${encodeURIComponent(text)}` : null,
        message_text: text
      };
    });

    await logSecurityEvent({
      organizationId: orgId,
      user: auth.user,
      action: 'CELL_REPORTS_REMIND_DISPATCHED',
      resource: 'cell_groups',
      details: { total_pending_reminders: reminders.length },
      event
    });

    return apiResponse(200, {
      message: `${reminders.length} líderes com relatórios pendentes identificados`,
      total: reminders.length,
      reminders
    });
  } catch (err: any) {
    console.error('Erro ao gerar lembretes de células:', err);
    return apiResponse(500, { error: 'Erro ao gerar lembretes para líderes de células' });
  }
};

// ==========================================
// HANDLER CONSOLIDADO PARA SERVERLESS ROUTING
// ==========================================
export const pastoralHandler = async (event: any): Promise<APIGatewayProxyResult> => {
  const method = (event.requestContext?.http?.method || event.httpMethod || 'GET').toUpperCase();
  const rawPath = event.rawPath || event.path || '';

  // Suporte a CORS Preflight OPTIONS
  if (method === 'OPTIONS') {
    return apiResponse(200, { ok: true });
  }

  // /pastoral/pending-cell-reports
  if (rawPath.includes('/pending-cell-reports') && method === 'GET') {
    return getPendingCellReports(event);
  }

  // /pastoral/remind-cell-leaders
  if (rawPath.includes('/remind-cell-leaders') && method === 'POST') {
    return remindCellLeaders(event);
  }

  // 1. /pastoral/absenteeism-radar
  if (rawPath.includes('/absenteeism-radar') && method === 'GET') {
    return getAbsenteeismRadar(event);
  }

  // 2. /pastoral/care-logs/{memberId} ou /pastoral/care-logs
  if (rawPath.includes('/care-logs')) {
    if (method === 'POST') return createCareLog(event);
    if (method === 'GET') {
      const parts = rawPath.split('/').filter(Boolean);
      if (parts.length >= 3) {
        if (!event.pathParameters) event.pathParameters = {};
        event.pathParameters.memberId = parts[parts.length - 1];
        return getMemberCareLogs(event);
      }
    }
  }

  // 3. /pastoral/visitors/{id}/stage
  if (rawPath.includes('/visitors/') && rawPath.endsWith('/stage') && (method === 'PUT' || method === 'POST')) {
    const parts = rawPath.split('/').filter(Boolean);
    const visIdx = parts.indexOf('visitors');
    if (!event.pathParameters) event.pathParameters = {};
    event.pathParameters.id = parts[visIdx + 1];
    return updateVisitorStage(event);
  }

  // 4. /pastoral/visitors/{id}/refer-cell
  if (rawPath.includes('/visitors/') && (rawPath.endsWith('/refer-cell') || rawPath.endsWith('/refer')) && (method === 'PUT' || method === 'POST')) {
    const parts = rawPath.split('/').filter(Boolean);
    const visIdx = parts.indexOf('visitors');
    if (!event.pathParameters) event.pathParameters = {};
    event.pathParameters.id = parts[visIdx + 1];
    return referVisitorToCell(event);
  }

  // 5. /pastoral/visitors ou /pastoral/visitors/{id}
  if (rawPath.includes('/visitors')) {
    const parts = rawPath.split('/').filter(Boolean);
    const visIdx = parts.indexOf('visitors');
    if (parts.length > visIdx + 1) {
      if (!event.pathParameters) event.pathParameters = {};
      event.pathParameters.id = parts[visIdx + 1];
      if (method === 'DELETE') return deleteVisitor(event);
    }
    if (method === 'GET') return listVisitors(event);
    if (method === 'POST') return registerVisitor(event);
  }

  // 6. /pastoral/executive-report
  if (rawPath.includes('/executive-report') && method === 'GET') {
    return getExecutiveReport(event);
  }

  // 7. /pastoral/members/{id}/timeline
  if (rawPath.includes('/members/') && rawPath.endsWith('/timeline') && method === 'GET') {
    const parts = rawPath.split('/').filter(Boolean);
    const memIdx = parts.indexOf('members');
    if (!event.pathParameters) event.pathParameters = {};
    event.pathParameters.id = parts[memIdx + 1];
    return getMemberTimeline360(event);
  }

  return apiResponse(404, { error: 'Rota pastoral não encontrada' });
};

