import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';

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
