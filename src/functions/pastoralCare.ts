import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';
import { checkRateLimit } from '../services/rateLimiter';

const PASTORAL_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER'];

// GET /pastoral/absenteeism-radar -> Radar de Ausências e Evasão
export const getAbsenteeismRadar = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
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
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, PASTORAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const qp = event.queryStringParameters || {};
    const requestedOrgId = qp.organization_id;
    const campusId = qp.campus_id;
    const stage = qp.stage;
    const search = qp.search;

    const tenantCheck = enforceTenant(auth.user, requestedOrgId);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgId = tenantCheck.effectiveOrgId;

    let sql = `
      SELECT 
        v.id,
        v.organization_id,
        v.campus_id,
        v.name,
        v.phone,
        v.email,
        v.neighborhood,
        v.origin_channel,
        v.stage,
        v.assigned_cell_id,
        v.assigned_leader_id,
        v.first_visit_date,
        v.notes,
        v.created_at,
        v.updated_at,
        DATEDIFF(CURRENT_DATE, v.first_visit_date) as days_since_first_visit,
        cg.name as cell_name,
        cg.meeting_day as cell_day,
        cg.meeting_time as cell_time,
        cg.neighborhood as cell_neighborhood,
        leader.name as leader_name,
        leader.phone as leader_phone
      FROM church_visitors v
      LEFT JOIN cell_groups cg ON v.assigned_cell_id = cg.id
      LEFT JOIN members leader ON v.assigned_leader_id = leader.id
      WHERE v.organization_id = ?
    `;
    const params: any[] = [orgId];

    if (campusId && campusId !== 'all') {
      sql += ` AND v.campus_id = ?`;
      params.push(campusId);
    }
    if (stage && stage !== 'ALL') {
      sql += ` AND v.stage = ?`;
      params.push(stage);
    }
    if (search) {
      sql += ` AND (v.name LIKE ? OR v.phone LIKE ? OR v.neighborhood LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ` ORDER BY v.created_at DESC`;

    const { rows } = await query(sql, params);
    return apiResponse(200, rows);
  } catch (err: any) {
    console.error('Erro ao listar visitantes:', err);
    return apiResponse(500, { error: 'Erro ao listar visitantes' });
  }
};

// POST /pastoral/visitors -> Cadastrar novo visitante (Recepção e QR Code Público)
export const registerVisitor = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { name, phone, email, neighborhood, origin_channel = 'SUNDAY_SERVICE', campus_id, notes, organization_id } = body;

    if (!name || !phone) {
      return apiResponse(400, { error: 'Nome e telefone/WhatsApp são obrigatórios' });
    }

    let effectiveOrgId = organization_id;
    let authUser: any = null;

    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (authHeader) {
      const auth = await requireAuth(event);
      if (!('errorResponse' in auth)) {
        authUser = auth.user;
        const tenantCheck = enforceTenant(auth.user, organization_id);
        if (tenantCheck.allowed) {
          effectiveOrgId = tenantCheck.effectiveOrgId;
        }
      }
    }

    if (!effectiveOrgId) {
      effectiveOrgId = 'org_default';
    }

    // Se é acesso público anônimo, aplica rate limiting estrito
    if (!authUser) {
      const rate = checkRateLimit(event, { maxRequests: 15, windowSeconds: 60, identifierPrefix: 'public_visitor' });
      if (!rate.allowed) return rate.errorResponse!;
    }

    const id = uuidv4();
    const cleanPhone = phone.replace(/\D/g, '');
    const firstVisitDate = body.first_visit_date || new Date().toISOString().split('T')[0];

    await query(`
      INSERT INTO church_visitors 
      (id, organization_id, campus_id, name, phone, email, neighborhood, origin_channel, stage, first_visit_date, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'NEW', ?, ?)
    `, [
      id,
      effectiveOrgId,
      campus_id || 'campus_sede',
      name.trim(),
      cleanPhone,
      email ? email.trim() : null,
      neighborhood ? neighborhood.trim() : null,
      origin_channel,
      firstVisitDate,
      notes || null
    ]);

    if (authUser) {
      await logSecurityEvent({
        organizationId: effectiveOrgId,
        user: authUser,
        action: 'REGISTER_VISITOR',
        resource: 'church_visitors',
        resourceId: id,
        details: { visitor_name: name, channel: origin_channel },
        event
      });
    }

    return apiResponse(201, {
      message: '✓ Visitante cadastrado com sucesso no acolhimento!',
      id,
      name,
      stage: 'NEW'
    });
  } catch (err: any) {
    console.error('Erro ao cadastrar visitante:', err);
    return apiResponse(500, { error: 'Erro ao cadastrar visitante' });
  }
};

// PUT /pastoral/visitors/{id}/stage -> Mover visitante no Funil Kanban
export const updateVisitorStage = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, PASTORAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const visitorId = event.pathParameters?.id || event.pathParameters?.visitorId;
    if (!visitorId) return apiResponse(400, { error: 'ID do visitante ausente' });

    const body = JSON.parse(event.body || '{}');
    const { stage } = body;

    const validStages = ['NEW', 'CONTACTED_24H', 'REFERRED_TO_CELL', 'ATTENDING_CELL', 'INTEGRATED_MEMBER', 'ARCHIVED'];
    if (!stage || !validStages.includes(stage)) {
      return apiResponse(400, { error: 'Etapa inválida' });
    }

    const { rows } = await query(`SELECT organization_id, name FROM church_visitors WHERE id = ? LIMIT 1`, [visitorId]);
    if (rows.length === 0) return apiResponse(404, { error: 'Visitante não encontrado' });

    const tenantCheck = enforceTenant(auth.user, rows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    await query(`
      UPDATE church_visitors 
      SET stage = ?, updated_at = NOW() 
      WHERE id = ? AND organization_id = ?
    `, [stage, visitorId, tenantCheck.effectiveOrgId]);

    return apiResponse(200, { message: 'Etapa do visitante atualizada com sucesso', stage });
  } catch (err: any) {
    console.error('Erro ao atualizar etapa:', err);
    return apiResponse(500, { error: 'Erro ao atualizar etapa do visitante' });
  }
};

// PUT /pastoral/visitors/{id}/refer-cell -> Encaminhar visitante para uma célula
export const referVisitorToCell = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, PASTORAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const visitorId = event.pathParameters?.id || event.pathParameters?.visitorId;
    if (!visitorId) return apiResponse(400, { error: 'ID do visitante ausente' });

    const body = JSON.parse(event.body || '{}');
    const { cell_group_id } = body;
    if (!cell_group_id) return apiResponse(400, { error: 'cell_group_id é obrigatório' });

    const { rows: visRows } = await query(`SELECT organization_id, name, phone, neighborhood FROM church_visitors WHERE id = ? LIMIT 1`, [visitorId]);
    if (visRows.length === 0) return apiResponse(404, { error: 'Visitante não encontrado' });

    const tenantCheck = enforceTenant(auth.user, visRows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    const { rows: cellRows } = await query(`
      SELECT cg.id, cg.name, cg.leader_id, m.name as leader_name, m.phone as leader_phone
      FROM cell_groups cg
      LEFT JOIN members m ON cg.leader_id = m.id
      WHERE cg.id = ? AND cg.organization_id = ?
      LIMIT 1
    `, [cell_group_id, tenantCheck.effectiveOrgId]);

    if (cellRows.length === 0) return apiResponse(404, { error: 'Célula não encontrada' });

    const cell = cellRows[0];

    await query(`
      UPDATE church_visitors 
      SET assigned_cell_id = ?, assigned_leader_id = ?, stage = 'REFERRED_TO_CELL', updated_at = NOW()
      WHERE id = ? AND organization_id = ?
    `, [cell_group_id, cell.leader_id, visitorId, tenantCheck.effectiveOrgId]);

    return apiResponse(200, {
      message: 'Visitante encaminhado para a célula com sucesso!',
      cell_name: cell.name,
      leader_name: cell.leader_name,
      leader_phone: cell.leader_phone,
      visitor_name: visRows[0].name,
      visitor_phone: visRows[0].phone
    });
  } catch (err: any) {
    console.error('Erro ao encaminhar visitante:', err);
    return apiResponse(500, { error: 'Erro ao encaminhar visitante' });
  }
};

// DELETE /pastoral/visitors/{id} -> Arquivar ou excluir visitante
export const deleteVisitor = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, PASTORAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const visitorId = event.pathParameters?.id || event.pathParameters?.visitorId;
    if (!visitorId) return apiResponse(400, { error: 'ID do visitante ausente' });

    const { rows } = await query(`SELECT organization_id FROM church_visitors WHERE id = ? LIMIT 1`, [visitorId]);
    if (rows.length === 0) return apiResponse(404, { error: 'Visitante não encontrado' });

    const tenantCheck = enforceTenant(auth.user, rows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    await query(`DELETE FROM church_visitors WHERE id = ? AND organization_id = ?`, [visitorId, tenantCheck.effectiveOrgId]);

    return apiResponse(200, { message: 'Visitante removido com sucesso' });
  } catch (err: any) {
    console.error('Erro ao excluir visitante:', err);
    return apiResponse(500, { error: 'Erro ao remover visitante' });
  }
};

// ==========================================
// RELATÓRIOS EXECUTIVOS & PRONTUÁRIO 360º
// ==========================================

// GET /pastoral/executive-report -> Métricas de retenção e rankings
export const getExecutiveReport = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, PASTORAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const requestedOrgId = event.queryStringParameters?.organization_id;
    const tenantCheck = enforceTenant(auth.user, requestedOrgId);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgId = tenantCheck.effectiveOrgId;

    // 1. Visitantes & Taxa de Conversão dos últimos 90 dias
    const { rows: visitorMetrics } = await query(`
      SELECT 
        COUNT(*) as total_visitors,
        SUM(CASE WHEN stage = 'NEW' THEN 1 ELSE 0 END) as stage_new,
        SUM(CASE WHEN stage = 'CONTACTED_24H' THEN 1 ELSE 0 END) as stage_contacted,
        SUM(CASE WHEN stage = 'REFERRED_TO_CELL' THEN 1 ELSE 0 END) as stage_referred,
        SUM(CASE WHEN stage = 'ATTENDING_CELL' THEN 1 ELSE 0 END) as stage_attending,
        SUM(CASE WHEN stage = 'INTEGRATED_MEMBER' THEN 1 ELSE 0 END) as stage_integrated
      FROM church_visitors
      WHERE organization_id = ?
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
    `, [orgId]);

    // 2. Ranking de Células: Presença Média e Saúde
    const { rows: cellHealth } = await query(`
      SELECT 
        cg.id,
        cg.name,
        cg.meeting_day,
        cg.neighborhood,
        leader.name as leader_name,
        COUNT(DISTINCT m.id) as total_members,
        (
          SELECT COUNT(*)
          FROM cell_meeting_attendees cma
          INNER JOIN cell_meetings cm ON cma.meeting_id = cm.id
          WHERE cm.cell_group_id = cg.id AND cma.status = 'PRESENT'
            AND cm.meeting_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        ) as total_attendances_30d,
        (
          SELECT COUNT(*)
          FROM cell_meetings cm
          WHERE cm.cell_group_id = cg.id
            AND cm.meeting_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        ) as meetings_count_30d
      FROM cell_groups cg
      LEFT JOIN members leader ON cg.leader_id = leader.id
      LEFT JOIN members m ON m.cell_group_id = cg.id AND m.status = 'ACTIVE'
      WHERE cg.organization_id = ?
      GROUP BY cg.id
      ORDER BY total_members DESC
    `, [orgId]);

    // 3. Contatos pastorais realizados no mês
    const { rows: careMetrics } = await query(`
      SELECT 
        contact_type,
        COUNT(*) as count
      FROM pastoral_care_logs
      WHERE organization_id = ?
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
      GROUP BY contact_type
    `, [orgId]);

    return apiResponse(200, {
      visitor_funnel: visitorMetrics[0] || {},
      cell_rankings: cellHealth,
      care_metrics: careMetrics
    });
  } catch (err: any) {
    console.error('Erro ao gerar relatório executivo:', err);
    return apiResponse(500, { error: 'Erro ao gerar relatório executivo' });
  }
};

// GET /pastoral/members/{id}/timeline -> Prontuário 360º pastoral do membro
export const getMemberTimeline360 = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, PASTORAL_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const memberId = event.pathParameters?.id || event.pathParameters?.memberId;
    if (!memberId) return apiResponse(400, { error: 'ID do membro ausente' });

    const { rows: memRows } = await query(`
      SELECT 
        m.id, m.name, m.phone, m.email, m.role, m.created_at, m.status,
        cg.name as cell_name, leader.name as leader_name, leader.phone as leader_phone
      FROM members m
      LEFT JOIN cell_groups cg ON m.cell_group_id = cg.id
      LEFT JOIN members leader ON cg.leader_id = leader.id
      WHERE m.id = ? LIMIT 1
    `, [memberId]);

    if (memRows.length === 0) return apiResponse(404, { error: 'Membro não encontrado' });
    const member = memRows[0];

    // Presenças nas reuniões de célula
    const { rows: meetings } = await query(`
      SELECT cm.meeting_date, cm.study_topic, cma.status as attendance_status, cma.justification
      FROM cell_meeting_attendees cma
      INNER JOIN cell_meetings cm ON cma.meeting_id = cm.id
      WHERE cma.member_id = ?
      ORDER BY cm.meeting_date DESC
      LIMIT 12
    `, [memberId]);

    // Histórico de cuidados pastorais
    const { rows: careLogs } = await query(`
      SELECT id, caregiver_name, contact_type, summary, scheduled_follow_up, created_at
      FROM pastoral_care_logs
      WHERE member_id = ?
      ORDER BY created_at DESC
    `, [memberId]);

    // Ministérios e escalas
    const { rows: ministries } = await query(`
      SELECT 
        m.name as ministry_name,
        mr.name as role_name,
        sri.status as confirmation_status,
        ss.title as service_title,
        ss.service_date,
        ss.service_time
      FROM service_roster_items sri
      INNER JOIN service_schedules ss ON sri.schedule_id = ss.id
      INNER JOIN ministries m ON ss.ministry_id = m.id
      INNER JOIN ministry_roles mr ON sri.role_id = mr.id
      WHERE sri.member_id = ?
      ORDER BY ss.service_date DESC
      LIMIT 10
    `, [memberId]);

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

// ==========================================
// HANDLER CONSOLIDADO PARA SERVERLESS ROUTING
// ==========================================
export const pastoralHandler = async (event: any): Promise<APIGatewayProxyResult> => {
  const method = (event.requestContext?.http?.method || event.httpMethod || 'GET').toUpperCase();
  const rawPath = event.rawPath || event.path || '';

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
  if (rawPath.includes('/visitors/') && rawPath.endsWith('/refer-cell') && (method === 'PUT' || method === 'POST')) {
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

