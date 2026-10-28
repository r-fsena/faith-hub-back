import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { apiResponse, getConnection, query } from '../db';
import { v4 as uuidv4 } from 'uuid';
import { logSecurityEvent } from '../services/auditLogService';
import {
  authorizeSecretariat,
  isSecretariatResponse as isResponse,
  safeSecretariatText as safeText,
  safeSecretariatDate as safeDate,
  secretariatCampusSql as campusSql
} from '../services/secretariatAccess';
import { handleSecretariatPhase2 } from './secretariatPhase2';

const MEMBERSHIP_STATUSES = new Set(['ACTIVE', 'PENDING', 'INACTIVE', 'TRANSFERRED', 'SUSPENDED']);
const ADMISSION_TYPES = new Set(['BAPTISM', 'TRANSFER', 'CONFESSION', 'RESTORATION', 'OTHER']);

export const getDashboard = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const scope = await authorizeSecretariat(event, 'secretariat.view');
    if (isResponse(scope)) return scope;

    const campus = campusSql('m', scope.campusId);
    const campusRecordClause = scope.campusId ? ' AND campus_id = ?' : '';
    const recordParams = scope.campusId ? [scope.organizationId, scope.campusId] : [scope.organizationId];

    const [memberResult, requestResult, documentResult, baptismResult, movementResult] = await Promise.all([
      query(`SELECT
          COUNT(*) AS total_members,
          SUM(CASE WHEN er.id IS NOT NULL THEN 1 ELSE 0 END) AS completed_records,
          SUM(CASE WHEN er.id IS NULL OR er.membership_status = 'PENDING' OR er.registry_number IS NULL THEN 1 ELSE 0 END) AS incomplete_records
        FROM members m
        LEFT JOIN member_ecclesiastical_records er
          ON er.organization_id = m.organization_id AND er.member_id = m.id
        WHERE m.organization_id = ?${campus.clause}`,
      [scope.organizationId, ...campus.params]),
      query(`SELECT COUNT(*) AS pending_requests FROM secretariat_requests
        WHERE organization_id = ?${campusRecordClause} AND status IN ('DRAFT', 'PENDING', 'UNDER_REVIEW')`, recordParams),
      query(`SELECT COUNT(*) AS issued_documents FROM issued_documents
        WHERE organization_id = ?${campusRecordClause} AND status = 'VALID'`, recordParams),
      query(`SELECT COUNT(*) AS baptism_records FROM baptism_records
        WHERE organization_id = ?${campusRecordClause}`, recordParams),
      query(`SELECT mm.id, mm.member_id, mm.movement_type, mm.status, mm.effective_date, mm.created_at,
          m.name AS member_name
        FROM membership_movements mm
        INNER JOIN members m ON m.id = mm.member_id AND m.organization_id = mm.organization_id
        WHERE mm.organization_id = ?${scope.campusId ? ' AND mm.campus_id = ?' : ''}
        ORDER BY mm.created_at DESC LIMIT 5`, recordParams)
    ]);

    const memberMetrics = memberResult.rows[0] || {};
    return apiResponse(200, {
      metrics: {
        total_members: Number(memberMetrics.total_members || 0),
        completed_records: Number(memberMetrics.completed_records || 0),
        incomplete_records: Number(memberMetrics.incomplete_records || 0),
        pending_requests: Number(requestResult.rows[0]?.pending_requests || 0),
        issued_documents: Number(documentResult.rows[0]?.issued_documents || 0),
        baptism_records: Number(baptismResult.rows[0]?.baptism_records || 0)
      },
      recent_movements: movementResult.rows
    });
  } catch (error: any) {
    console.error('Erro ao carregar painel da Secretaria:', error);
    return apiResponse(500, { error: 'Não foi possível carregar o painel da Secretaria.' });
  }
};

export const listRecords = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const scope = await authorizeSecretariat(event, 'secretariat.view', {}, 'secretariat.member_registry');
    if (isResponse(scope)) return scope;

    const search = safeText(event.queryStringParameters?.search, 100);
    const status = safeText(event.queryStringParameters?.status, 30)?.toUpperCase();
    const limit = Math.min(Math.max(Number(event.queryStringParameters?.limit || 50), 1), 100);
    const offset = Math.max(Number(event.queryStringParameters?.offset || 0), 0);
    const campus = campusSql('m', scope.campusId);

    let sql = `SELECT
        m.id AS member_id, m.name, m.email, m.phone, m.status AS account_status,
        m.campus_id, m.campus_ids, c.name AS campus_name,
        er.id AS record_id, er.registry_number, er.membership_status, er.admission_type,
        er.admission_date, er.origin_church_name, er.baptism_date, er.baptism_church,
        er.baptism_city, er.baptism_officiant, er.notes, er.updated_at
      FROM members m
      LEFT JOIN member_ecclesiastical_records er
        ON er.organization_id = m.organization_id AND er.member_id = m.id
      LEFT JOIN campuses c ON c.organization_id = m.organization_id AND c.id = m.campus_id
      WHERE m.organization_id = ?${campus.clause}`;
    const params: any[] = [scope.organizationId, ...campus.params];

    if (search) {
      sql += ` AND (m.name LIKE ? OR m.email LIKE ? OR m.phone LIKE ? OR er.registry_number LIKE ?)`;
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    if (status && MEMBERSHIP_STATUSES.has(status)) {
      sql += ` AND COALESCE(er.membership_status, 'PENDING') = ?`;
      params.push(status);
    }
    sql += ` ORDER BY m.name ASC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const result = await query(sql, params);
    const data = result.rows.map((record: any) => ({
      ...record,
      campus_ids: typeof record.campus_ids === 'string' ? JSON.parse(record.campus_ids || '[]') : (record.campus_ids || [])
    }));
    return apiResponse(200, { data, pagination: { limit, offset, returned: data.length } });
  } catch (error: any) {
    console.error('Erro ao listar prontuários da Secretaria:', error);
    return apiResponse(500, { error: 'Não foi possível listar os prontuários.' });
  }
};

export const getRecord = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const scope = await authorizeSecretariat(event, 'secretariat.view', {}, 'secretariat.member_registry');
    if (isResponse(scope)) return scope;
    const memberId = event.pathParameters?.proxy?.match(/^members\/([^/]+)\/record$/)?.[1];
    if (!memberId) return apiResponse(400, { error: 'Identificador do membro é obrigatório.' });
    const campus = campusSql('m', scope.campusId);

    const result = await query(`SELECT m.id AS member_id, m.name, m.email, m.phone, m.campus_id,
        c.name AS campus_name, er.*
      FROM members m
      LEFT JOIN member_ecclesiastical_records er
        ON er.organization_id = m.organization_id AND er.member_id = m.id
      LEFT JOIN campuses c ON c.organization_id = m.organization_id AND c.id = m.campus_id
      WHERE m.organization_id = ? AND m.id = ?${campus.clause}
      LIMIT 1`, [scope.organizationId, memberId, ...campus.params]);
    if (!result.rows.length) return apiResponse(404, { error: 'Membro não encontrado nesta organização.' });
    return apiResponse(200, { data: result.rows[0] });
  } catch (error: any) {
    console.error('Erro ao consultar prontuário eclesiástico:', error);
    return apiResponse(500, { error: 'Não foi possível consultar o prontuário.' });
  }
};

export const upsertRecord = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const scope = await authorizeSecretariat(event, 'secretariat.manage_members', body, 'secretariat.member_registry');
    if (isResponse(scope)) return scope;
    const memberId = event.pathParameters?.proxy?.match(/^members\/([^/]+)\/record$/)?.[1];
    if (!memberId) return apiResponse(400, { error: 'Identificador do membro é obrigatório.' });

    const membershipStatus = safeText(body.membership_status, 30)?.toUpperCase() || 'PENDING';
    const admissionType = safeText(body.admission_type, 30)?.toUpperCase();
    if (!MEMBERSHIP_STATUSES.has(membershipStatus)) return apiResponse(400, { error: 'Situação de membresia inválida.' });
    if (admissionType && !ADMISSION_TYPES.has(admissionType)) return apiResponse(400, { error: 'Tipo de admissão inválido.' });

    const data = {
      registryNumber: safeText(body.registry_number, 50),
      membershipStatus,
      admissionType,
      admissionDate: safeDate(body.admission_date),
      originChurchName: safeText(body.origin_church_name, 255),
      baptismDate: safeDate(body.baptism_date),
      baptismChurch: safeText(body.baptism_church, 255),
      baptismCity: safeText(body.baptism_city, 150),
      baptismOfficiant: safeText(body.baptism_officiant, 255),
      notes: safeText(body.notes, 5000)
    };

    const connection = await getConnection();
    try {
      await connection.beginTransaction();
      const campus = campusSql('m', scope.campusId);
      const [members]: any = await connection.query(
        `SELECT m.id, m.campus_id FROM members m WHERE m.organization_id = ? AND m.id = ?${campus.clause} LIMIT 1 FOR UPDATE`,
        [scope.organizationId, memberId, ...campus.params]
      );
      if (!members.length) {
        await connection.rollback();
        return apiResponse(404, { error: 'Membro não encontrado nesta organização.' });
      }
      const campusId = members[0].campus_id || scope.campusId || null;
      const recordId = uuidv4();
      await connection.query(`INSERT INTO member_ecclesiastical_records (
          id, organization_id, campus_id, member_id, registry_number, membership_status,
          admission_type, admission_date, origin_church_name, baptism_date, baptism_church,
          baptism_city, baptism_officiant, notes, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          campus_id = VALUES(campus_id), registry_number = VALUES(registry_number),
          membership_status = VALUES(membership_status), admission_type = VALUES(admission_type),
          admission_date = VALUES(admission_date), origin_church_name = VALUES(origin_church_name),
          baptism_date = VALUES(baptism_date), baptism_church = VALUES(baptism_church),
          baptism_city = VALUES(baptism_city), baptism_officiant = VALUES(baptism_officiant),
          notes = VALUES(notes), updated_by = VALUES(updated_by), updated_at = NOW()`, [
        recordId, scope.organizationId, campusId, memberId, data.registryNumber, data.membershipStatus,
        data.admissionType, data.admissionDate, data.originChurchName, data.baptismDate, data.baptismChurch,
        data.baptismCity, data.baptismOfficiant, data.notes, scope.user.userId, scope.user.userId
      ]);
      await connection.query(
        `UPDATE members SET baptism_date = ?, updated_at = NOW() WHERE organization_id = ? AND id = ?`,
        [data.baptismDate, scope.organizationId, memberId]
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    await logSecurityEvent({
      organizationId: scope.organizationId,
      campusId: scope.campusId,
      user: scope.user,
      action: 'UPSERT_ECCLESIASTICAL_RECORD',
      resource: 'member_ecclesiastical_records',
      resourceId: memberId,
      details: {
        fields: Object.keys(data),
        membership_status: data.membershipStatus,
        has_registry_number: Boolean(data.registryNumber)
      },
      event
    });

    const updated = await query(
      `SELECT * FROM member_ecclesiastical_records WHERE organization_id = ? AND member_id = ? LIMIT 1`,
      [scope.organizationId, memberId]
    );
    return apiResponse(200, { message: 'Prontuário eclesiástico atualizado com sucesso.', data: updated.rows[0] });
  } catch (error: any) {
    if (error?.message === 'INVALID_DATE') return apiResponse(400, { error: 'Uma das datas informadas é inválida.' });
    if (error?.code === 'ER_DUP_ENTRY') return apiResponse(409, { error: 'O número de registro já está em uso nesta organização.' });
    console.error('Erro ao salvar prontuário eclesiástico:', error);
    return apiResponse(500, { error: 'Não foi possível salvar o prontuário.' });
  }
};

export const secretariatHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod || (event.requestContext as any)?.http?.method || 'GET';
  const proxy = event.pathParameters?.proxy || '';

  if (method === 'GET' && proxy === 'dashboard') return getDashboard(event);
  if (method === 'GET' && proxy === 'records') return listRecords(event);
  if (method === 'GET' && /^members\/[^/]+\/record$/.test(proxy)) return getRecord(event);
  if (method === 'PUT' && /^members\/[^/]+\/record$/.test(proxy)) return upsertRecord(event);

  const phase2Response = await handleSecretariatPhase2(event, method, proxy);
  if (phase2Response) return phase2Response;

  return apiResponse(404, { error: 'Rota da Secretaria não encontrada.' });
};
