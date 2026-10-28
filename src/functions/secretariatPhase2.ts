import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { apiResponse, getConnection, query } from '../db';
import { v4 as uuidv4 } from 'uuid';
import { logSecurityEvent } from '../services/auditLogService';
import {
  authorizeSecretariat,
  isSecretariatResponse,
  phase2CampusSql,
  safeSecretariatDate,
  safeSecretariatText,
  secretariatCampusSql,
  SecretariatScope
} from '../services/secretariatAccess';

const MOVEMENT_TYPES = new Set(['INTERNAL_TRANSFER', 'EXTERNAL_TRANSFER_OUT', 'EXTERNAL_TRANSFER_IN']);
const MOVEMENT_STATUSES = new Set(['APPROVED', 'REJECTED', 'CANCELED']);
const REQUEST_TYPES = new Set(['LETTER_PRESENTATION', 'LETTER_TRANSFER', 'BAPTISM_CERTIFICATE', 'DECLARATION', 'OTHER']);
const REQUEST_STATUSES = new Set(['UNDER_REVIEW', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELED']);
const DOCUMENT_TYPES = new Set(['PRESENTATION_LETTER', 'TRANSFER_LETTER', 'BAPTISM_CERTIFICATE', 'DECLARATION', 'OTHER']);

function parseBody(event: APIGatewayProxyEvent): any {
  try {
    return JSON.parse(event.body || '{}');
  } catch {
    throw new Error('INVALID_JSON');
  }
}

function parseStoredJson(value: any, fallback: any = {}): any {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function memberIdFromProxy(proxy: string): string | null {
  const match = proxy.match(/^[^/]+\/([^/]+)(?:\/status)?$/);
  return match?.[1] || null;
}

function sanitizeFields(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .slice(0, 30)
    .map(([key, fieldValue]) => [key.slice(0, 80), String(fieldValue ?? '').slice(0, 1000)]));
}

function renderTemplateValue(value: any, fields: Record<string, string>): any {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => fields[key] ?? '');
  }
  if (Array.isArray(value)) return value.map(item => renderTemplateValue(item, fields));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTemplateValue(item, fields)]));
  }
  return value;
}

function errorResponse(error: any, context: string): APIGatewayProxyResult {
  if (error?.message === 'INVALID_JSON') return apiResponse(400, { error: 'O formulário enviado não contém um JSON válido.' });
  if (error?.message === 'INVALID_DATE') return apiResponse(400, { error: 'Uma das datas informadas é inválida.' });
  if (error?.code === 'ER_DUP_ENTRY') return apiResponse(409, { error: 'Já existe um registro com estes dados.' });
  console.error(context, error);
  return apiResponse(500, { error: 'Não foi possível concluir a operação da Secretaria.' });
}

async function getScopedMember(scope: SecretariatScope, memberId: string): Promise<any | null> {
  const campus = secretariatCampusSql('m', scope.campusId);
  const result = await query(`SELECT m.id, m.name, m.email, m.phone, m.campus_id, m.campus_ids,
      er.registry_number, er.membership_status, er.baptism_date
    FROM members m
    LEFT JOIN member_ecclesiastical_records er
      ON er.organization_id = m.organization_id AND er.member_id = m.id
    WHERE m.organization_id = ? AND m.id = ?${campus.clause}
    LIMIT 1`, [scope.organizationId, memberId, ...campus.params]);
  return result.rows[0] || null;
}

export const getReferenceData = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const scope = await authorizeSecretariat(event, 'secretariat.view');
    if (isSecretariatResponse(scope)) return scope;
    const memberCampus = secretariatCampusSql('m', scope.campusId);
    const sharedEntityClause = scope.campusId ? ' AND (x.campus_id IS NULL OR x.campus_id = ?)' : '';
    const sharedEntityParams = scope.campusId ? [scope.campusId] : [];
    const [members, campuses, templates, signatories] = await Promise.all([
      query(`SELECT m.id, m.name, m.email, m.campus_id, c.name AS campus_name,
          er.registry_number, er.membership_status
        FROM members m
        LEFT JOIN campuses c ON c.organization_id = m.organization_id AND c.id = m.campus_id
        LEFT JOIN member_ecclesiastical_records er ON er.organization_id = m.organization_id AND er.member_id = m.id
        WHERE m.organization_id = ?${memberCampus.clause}
        ORDER BY m.name ASC LIMIT 500`, [scope.organizationId, ...memberCampus.params]),
      query(`SELECT id, name FROM campuses WHERE organization_id = ? ORDER BY name ASC`, [scope.organizationId]),
      query(`SELECT x.id, x.name, x.document_type, x.version, x.template_schema
        FROM document_templates x WHERE x.organization_id = ? AND x.is_active = 1${sharedEntityClause}
        ORDER BY x.document_type, x.name, x.version DESC`, [scope.organizationId, ...sharedEntityParams]),
      query(`SELECT x.id, x.name, x.title, x.campus_id
        FROM document_signatories x WHERE x.organization_id = ? AND x.is_active = 1${sharedEntityClause}
        ORDER BY x.name ASC`, [scope.organizationId, ...sharedEntityParams])
    ]);
    return apiResponse(200, {
      members: members.rows,
      campuses: campuses.rows,
      templates: templates.rows.map((item: any) => ({ ...item, template_schema: parseStoredJson(item.template_schema) })),
      signatories: signatories.rows
    });
  } catch (error: any) {
    return errorResponse(error, 'Erro ao carregar dados de referência da Secretaria:');
  }
};

export const listMovements = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const scope = await authorizeSecretariat(event, 'secretariat.view', {}, 'secretariat.transfers');
    if (isSecretariatResponse(scope)) return scope;
    const campus = phase2CampusSql('mm', scope.campusId);
    const result = await query(`SELECT mm.*, m.name AS member_name,
        fc.name AS from_campus_name, tc.name AS to_campus_name,
        requester.name AS requested_by_name, approver.name AS approved_by_name
      FROM membership_movements mm
      INNER JOIN members m ON m.organization_id = mm.organization_id AND m.id = mm.member_id
      LEFT JOIN campuses fc ON fc.organization_id = mm.organization_id AND fc.id = mm.from_campus_id
      LEFT JOIN campuses tc ON tc.organization_id = mm.organization_id AND tc.id = mm.to_campus_id
      LEFT JOIN members requester ON requester.organization_id = mm.organization_id AND requester.id = mm.requested_by
      LEFT JOIN members approver ON approver.organization_id = mm.organization_id AND approver.id = mm.approved_by
      WHERE mm.organization_id = ?${campus.clause}
      ORDER BY mm.created_at DESC LIMIT 200`, [scope.organizationId, ...campus.params]);
    return apiResponse(200, { data: result.rows });
  } catch (error: any) {
    return errorResponse(error, 'Erro ao listar movimentações:');
  }
};

export const createMovement = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = parseBody(event);
    const scope = await authorizeSecretariat(event, 'secretariat.manage_transfers', body, 'secretariat.transfers');
    if (isSecretariatResponse(scope)) return scope;
    const memberId = safeSecretariatText(body.member_id, 36);
    const movementType = safeSecretariatText(body.movement_type, 40)?.toUpperCase();
    if (!memberId || !movementType || !MOVEMENT_TYPES.has(movementType)) {
      return apiResponse(400, { error: 'Membro e tipo de movimentação válidos são obrigatórios.' });
    }
    const member = await getScopedMember(scope, memberId);
    if (!member) return apiResponse(404, { error: 'Membro não encontrado nesta organização ou unidade.' });
    if (scope.campusId && member.campus_id !== scope.campusId) {
      return apiResponse(409, { error: 'A transferência deve ser iniciada pela unidade principal atual do membro.' });
    }

    const toCampusId = safeSecretariatText(body.to_campus_id, 36);
    const externalChurch = safeSecretariatText(body.external_church_name, 255);
    const reason = safeSecretariatText(body.reason, 2000);
    if (!reason) return apiResponse(400, { error: 'Informe o motivo da movimentação.' });
    if (movementType === 'INTERNAL_TRANSFER') {
      if (!toCampusId || toCampusId === member.campus_id) return apiResponse(400, { error: 'Selecione uma unidade de destino diferente da unidade atual.' });
      const campus = await query(`SELECT id FROM campuses WHERE organization_id = ? AND id = ? LIMIT 1`, [scope.organizationId, toCampusId]);
      if (!campus.rows.length) return apiResponse(404, { error: 'Unidade de destino não encontrada nesta organização.' });
    } else if (!externalChurch) {
      return apiResponse(400, { error: 'Informe a igreja de origem ou destino da transferência externa.' });
    }

    const id = uuidv4();
    await query(`INSERT INTO membership_movements (
        id, organization_id, campus_id, member_id, movement_type, status,
        from_organization_id, to_organization_id, from_campus_id, to_campus_id,
        external_church_name, effective_date, reason, notes, requested_by
      ) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id, scope.organizationId, member.campus_id || scope.campusId, memberId, movementType,
      scope.organizationId, movementType === 'INTERNAL_TRANSFER' ? scope.organizationId : null,
      member.campus_id || null, toCampusId, externalChurch,
      safeSecretariatDate(body.effective_date), reason,
      safeSecretariatText(body.notes, 5000), scope.user.userId
    ]);
    await logSecurityEvent({
      organizationId: scope.organizationId, campusId: member.campus_id, user: scope.user,
      action: 'CREATE_MEMBERSHIP_MOVEMENT', resource: 'membership_movements', resourceId: id,
      details: { member_id: memberId, movement_type: movementType, status: 'PENDING' }, event
    });
    return apiResponse(201, { message: 'Movimentação enviada para análise.', id, status: 'PENDING' });
  } catch (error: any) {
    return errorResponse(error, 'Erro ao criar movimentação:');
  }
};

export const updateMovementStatus = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = parseBody(event);
    const scope = await authorizeSecretariat(event, 'secretariat.approve', body, 'secretariat.transfers');
    if (isSecretariatResponse(scope)) return scope;
    const movementId = memberIdFromProxy(event.pathParameters?.proxy || '');
    const status = safeSecretariatText(body.status, 30)?.toUpperCase();
    if (!movementId || !status || !MOVEMENT_STATUSES.has(status)) return apiResponse(400, { error: 'Situação da movimentação inválida.' });

    const connection = await getConnection();
    let movement: any;
    try {
      await connection.beginTransaction();
      const campus = phase2CampusSql('mm', scope.campusId);
      const [movements]: any = await connection.query(
        `SELECT mm.* FROM membership_movements mm WHERE mm.organization_id = ? AND mm.id = ?${campus.clause} LIMIT 1 FOR UPDATE`,
        [scope.organizationId, movementId, ...campus.params]
      );
      movement = movements[0];
      if (!movement) {
        await connection.rollback();
        return apiResponse(404, { error: 'Movimentação não encontrada nesta organização ou unidade.' });
      }
      if (movement.status !== 'PENDING' && movement.status !== 'UNDER_REVIEW') {
        await connection.rollback();
        return apiResponse(409, { error: 'Esta movimentação já recebeu uma decisão.' });
      }

      if (status === 'APPROVED') {
        if (movement.movement_type === 'INTERNAL_TRANSFER') {
          const [campuses]: any = await connection.query(
            `SELECT id FROM campuses WHERE organization_id = ? AND id = ? LIMIT 1 FOR UPDATE`,
            [scope.organizationId, movement.to_campus_id]
          );
          if (!campuses.length) throw new Error('DESTINATION_CAMPUS_NOT_FOUND');
          await connection.query(`UPDATE members SET campus_id = ?, campus_ids = JSON_ARRAY(?), updated_at = NOW()
            WHERE organization_id = ? AND id = ?`, [movement.to_campus_id, movement.to_campus_id, scope.organizationId, movement.member_id]);
          await connection.query(`UPDATE member_ecclesiastical_records SET campus_id = ?, updated_by = ?, updated_at = NOW()
            WHERE organization_id = ? AND member_id = ?`, [movement.to_campus_id, scope.user.userId, scope.organizationId, movement.member_id]);
        } else {
          const membershipStatus = movement.movement_type === 'EXTERNAL_TRANSFER_OUT' ? 'TRANSFERRED' : 'ACTIVE';
          const admissionType = movement.movement_type === 'EXTERNAL_TRANSFER_IN' ? 'TRANSFER' : null;
          await connection.query(`INSERT INTO member_ecclesiastical_records (
              id, organization_id, campus_id, member_id, membership_status, admission_type,
              admission_date, origin_church_name, created_by, updated_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE membership_status = VALUES(membership_status),
              admission_type = COALESCE(VALUES(admission_type), admission_type),
              admission_date = COALESCE(VALUES(admission_date), admission_date),
              origin_church_name = COALESCE(VALUES(origin_church_name), origin_church_name),
              updated_by = VALUES(updated_by), updated_at = NOW()`, [
            uuidv4(), scope.organizationId, movement.campus_id, movement.member_id, membershipStatus,
            admissionType, movement.effective_date, movement.external_church_name,
            scope.user.userId, scope.user.userId
          ]);
        }
      }
      await connection.query(`UPDATE membership_movements SET status = ?, approved_by = ?, approved_at = NOW(), updated_at = NOW()
        WHERE organization_id = ? AND id = ?`, [status, scope.user.userId, scope.organizationId, movementId]);
      await connection.commit();
    } catch (error: any) {
      await connection.rollback();
      if (error?.message === 'DESTINATION_CAMPUS_NOT_FOUND') return apiResponse(404, { error: 'Unidade de destino não encontrada.' });
      throw error;
    } finally {
      connection.release();
    }
    await logSecurityEvent({
      organizationId: scope.organizationId, campusId: movement.campus_id, user: scope.user,
      action: 'DECIDE_MEMBERSHIP_MOVEMENT', resource: 'membership_movements', resourceId: movementId,
      details: { member_id: movement.member_id, movement_type: movement.movement_type, status }, event
    });
    return apiResponse(200, { message: 'Situação da movimentação atualizada.', status });
  } catch (error: any) {
    return errorResponse(error, 'Erro ao decidir movimentação:');
  }
};

export const listRequests = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const scope = await authorizeSecretariat(event, 'secretariat.view', {}, 'secretariat.documents');
    if (isSecretariatResponse(scope)) return scope;
    const campus = phase2CampusSql('sr', scope.campusId);
    const result = await query(`SELECT sr.*, m.name AS member_name, assignee.name AS assigned_to_name
      FROM secretariat_requests sr
      LEFT JOIN members m ON m.organization_id = sr.organization_id AND m.id = sr.member_id
      LEFT JOIN members assignee ON assignee.organization_id = sr.organization_id AND assignee.id = sr.assigned_to
      WHERE sr.organization_id = ?${campus.clause}
      ORDER BY sr.created_at DESC LIMIT 200`, [scope.organizationId, ...campus.params]);
    return apiResponse(200, { data: result.rows.map((item: any) => ({ ...item, payload: parseStoredJson(item.payload) })) });
  } catch (error: any) {
    return errorResponse(error, 'Erro ao listar solicitações:');
  }
};

export const createRequest = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = parseBody(event);
    const scope = await authorizeSecretariat(event, 'secretariat.issue_documents', body, 'secretariat.documents');
    if (isSecretariatResponse(scope)) return scope;
    const memberId = safeSecretariatText(body.member_id, 36);
    const requestType = safeSecretariatText(body.request_type, 50)?.toUpperCase();
    if (!memberId || !requestType || !REQUEST_TYPES.has(requestType)) return apiResponse(400, { error: 'Membro e tipo de solicitação são obrigatórios.' });
    const member = await getScopedMember(scope, memberId);
    if (!member) return apiResponse(404, { error: 'Membro não encontrado nesta organização ou unidade.' });
    const id = uuidv4();
    const payload = { fields: sanitizeFields(body.fields), notes: safeSecretariatText(body.notes, 5000) };
    await query(`INSERT INTO secretariat_requests (
        id, organization_id, campus_id, member_id, request_type, status, payload, requested_by
      ) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`, [
      id, scope.organizationId, scope.campusId || member.campus_id, memberId, requestType, JSON.stringify(payload), scope.user.userId
    ]);
    await logSecurityEvent({ organizationId: scope.organizationId, campusId: member.campus_id, user: scope.user,
      action: 'CREATE_SECRETARIAT_REQUEST', resource: 'secretariat_requests', resourceId: id,
      details: { member_id: memberId, request_type: requestType }, event });
    return apiResponse(201, { message: 'Solicitação criada com sucesso.', id, status: 'PENDING' });
  } catch (error: any) {
    return errorResponse(error, 'Erro ao criar solicitação:');
  }
};

export const updateRequestStatus = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = parseBody(event);
    const scope = await authorizeSecretariat(event, 'secretariat.approve', body, 'secretariat.documents');
    if (isSecretariatResponse(scope)) return scope;
    const requestId = memberIdFromProxy(event.pathParameters?.proxy || '');
    const status = safeSecretariatText(body.status, 30)?.toUpperCase();
    if (!requestId || !status || !REQUEST_STATUSES.has(status)) return apiResponse(400, { error: 'Situação da solicitação inválida.' });
    const campus = phase2CampusSql('secretariat_requests', scope.campusId);
    const approved = status === 'APPROVED' || status === 'COMPLETED';
    const completed = status === 'COMPLETED';
    const result = await query(`UPDATE secretariat_requests SET status = ?, assigned_to = COALESCE(assigned_to, ?),
        approved_by = CASE WHEN ? THEN ? ELSE approved_by END,
        approved_at = CASE WHEN ? THEN COALESCE(approved_at, NOW()) ELSE approved_at END,
        completed_at = CASE WHEN ? THEN NOW() ELSE completed_at END, updated_at = NOW()
      WHERE organization_id = ? AND id = ?${campus.clause}`, [
      status, scope.user.userId, approved, scope.user.userId, approved, completed,
      scope.organizationId, requestId, ...campus.params
    ]);
    if (!(result.rows as any)?.affectedRows) return apiResponse(404, { error: 'Solicitação não encontrada nesta organização ou unidade.' });
    await logSecurityEvent({ organizationId: scope.organizationId, campusId: scope.campusId, user: scope.user,
      action: 'UPDATE_SECRETARIAT_REQUEST_STATUS', resource: 'secretariat_requests', resourceId: requestId,
      details: { status }, event });
    return apiResponse(200, { message: 'Situação da solicitação atualizada.', status });
  } catch (error: any) {
    return errorResponse(error, 'Erro ao atualizar solicitação:');
  }
};

export const listBaptisms = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const scope = await authorizeSecretariat(event, 'secretariat.view', {}, 'secretariat.baptisms');
    if (isSecretariatResponse(scope)) return scope;
    const campus = phase2CampusSql('br', scope.campusId);
    const result = await query(`SELECT br.*, m.name AS member_name, m.email AS member_email, c.name AS campus_name
      FROM baptism_records br
      INNER JOIN members m ON m.organization_id = br.organization_id AND m.id = br.member_id
      LEFT JOIN campuses c ON c.organization_id = br.organization_id AND c.id = br.campus_id
      WHERE br.organization_id = ?${campus.clause}
      ORDER BY br.baptism_date DESC, br.created_at DESC LIMIT 200`, [scope.organizationId, ...campus.params]);
    return apiResponse(200, { data: result.rows });
  } catch (error: any) {
    return errorResponse(error, 'Erro ao listar batismos:');
  }
};

export const createBaptism = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = parseBody(event);
    const scope = await authorizeSecretariat(event, 'secretariat.manage_baptisms', body, 'secretariat.baptisms');
    if (isSecretariatResponse(scope)) return scope;
    const memberId = safeSecretariatText(body.member_id, 36);
    const baptismDate = safeSecretariatDate(body.baptism_date);
    if (!memberId || !baptismDate) return apiResponse(400, { error: 'Membro e data do batismo são obrigatórios.' });
    const member = await getScopedMember(scope, memberId);
    if (!member) return apiResponse(404, { error: 'Membro não encontrado nesta organização ou unidade.' });
    const id = uuidv4();
    const baptismChurch = safeSecretariatText(body.baptism_church, 255);
    const baptismCity = safeSecretariatText(body.baptism_city, 150);
    const officiant = safeSecretariatText(body.officiant_name, 255);
    const connection = await getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(`INSERT INTO baptism_records (
          id, organization_id, campus_id, member_id, baptism_date, baptism_church,
          baptism_location, baptism_city, officiant_name, ceremony_name, notes, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id, scope.organizationId, scope.campusId || member.campus_id, memberId, baptismDate, baptismChurch,
        safeSecretariatText(body.baptism_location, 255), baptismCity, officiant,
        safeSecretariatText(body.ceremony_name, 255), safeSecretariatText(body.notes, 5000), scope.user.userId
      ]);
      await connection.query(`UPDATE members SET baptism_date = ?, updated_at = NOW()
        WHERE organization_id = ? AND id = ?`, [baptismDate, scope.organizationId, memberId]);
      await connection.query(`INSERT INTO member_ecclesiastical_records (
          id, organization_id, campus_id, member_id, baptism_date, baptism_church,
          baptism_city, baptism_officiant, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE baptism_date = VALUES(baptism_date), baptism_church = VALUES(baptism_church),
          baptism_city = VALUES(baptism_city), baptism_officiant = VALUES(baptism_officiant),
          updated_by = VALUES(updated_by), updated_at = NOW()`, [
        uuidv4(), scope.organizationId, scope.campusId || member.campus_id, memberId,
        baptismDate, baptismChurch, baptismCity, officiant, scope.user.userId, scope.user.userId
      ]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    await logSecurityEvent({ organizationId: scope.organizationId, campusId: member.campus_id, user: scope.user,
      action: 'CREATE_BAPTISM_RECORD', resource: 'baptism_records', resourceId: id,
      details: { member_id: memberId, baptism_date: baptismDate }, event });
    return apiResponse(201, { message: 'Batismo registrado com sucesso.', id });
  } catch (error: any) {
    return errorResponse(error, 'Erro ao registrar batismo:');
  }
};

export const listTemplates = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const scope = await authorizeSecretariat(event, 'secretariat.view', {}, 'secretariat.documents');
    if (isSecretariatResponse(scope)) return scope;
    const campusClause = scope.campusId ? ' AND (dt.campus_id IS NULL OR dt.campus_id = ?)' : '';
    const campusParams = scope.campusId ? [scope.campusId] : [];
    const result = await query(`SELECT dt.* FROM document_templates dt
      WHERE dt.organization_id = ?${campusClause}
      ORDER BY dt.document_type, dt.name, dt.version DESC`, [scope.organizationId, ...campusParams]);
    return apiResponse(200, { data: result.rows.map((item: any) => ({ ...item, template_schema: parseStoredJson(item.template_schema) })) });
  } catch (error: any) {
    return errorResponse(error, 'Erro ao listar modelos:');
  }
};

export const createTemplate = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = parseBody(event);
    const scope = await authorizeSecretariat(event, 'secretariat.manage_templates', body, 'secretariat.documents');
    if (isSecretariatResponse(scope)) return scope;
    const documentType = safeSecretariatText(body.document_type, 50)?.toUpperCase();
    const name = safeSecretariatText(body.name, 150);
    const schema = body.template_schema;
    if (!documentType || !DOCUMENT_TYPES.has(documentType) || !name || !schema || typeof schema !== 'object' || typeof schema.body !== 'string') {
      return apiResponse(400, { error: 'Tipo, nome e conteúdo do modelo são obrigatórios.' });
    }
    const versionResult = await query(`SELECT COALESCE(MAX(version), 0) + 1 AS next_version
      FROM document_templates WHERE organization_id = ? AND document_type = ? AND name = ?`,
    [scope.organizationId, documentType, name]);
    const version = Number(versionResult.rows[0]?.next_version || 1);
    const id = uuidv4();
    const templateSchema = {
      title: safeSecretariatText(schema.title, 250) || name,
      body: String(schema.body).slice(0, 20000),
      footer: safeSecretariatText(schema.footer, 2000),
      orientation: schema.orientation === 'landscape' ? 'landscape' : 'portrait'
    };
    await query(`INSERT INTO document_templates (
        id, organization_id, campus_id, document_type, name, version, template_schema, is_active, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, [
      id, scope.organizationId, scope.campusId, documentType, name, version,
      JSON.stringify(templateSchema), scope.user.userId, scope.user.userId
    ]);
    await logSecurityEvent({ organizationId: scope.organizationId, campusId: scope.campusId, user: scope.user,
      action: 'CREATE_DOCUMENT_TEMPLATE', resource: 'document_templates', resourceId: id,
      details: { document_type: documentType, name, version }, event });
    return apiResponse(201, { message: 'Nova versão do modelo criada.', id, version });
  } catch (error: any) {
    return errorResponse(error, 'Erro ao criar modelo:');
  }
};

export const listSignatories = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const scope = await authorizeSecretariat(event, 'secretariat.view', {}, 'secretariat.documents');
    if (isSecretariatResponse(scope)) return scope;
    const campusClause = scope.campusId ? ' AND (ds.campus_id IS NULL OR ds.campus_id = ?)' : '';
    const campusParams = scope.campusId ? [scope.campusId] : [];
    const result = await query(`SELECT ds.* FROM document_signatories ds
      WHERE ds.organization_id = ?${campusClause} ORDER BY ds.is_active DESC, ds.name ASC`,
    [scope.organizationId, ...campusParams]);
    return apiResponse(200, { data: result.rows });
  } catch (error: any) {
    return errorResponse(error, 'Erro ao listar signatários:');
  }
};

export const createSignatory = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = parseBody(event);
    const scope = await authorizeSecretariat(event, 'secretariat.manage_templates', body, 'secretariat.documents');
    if (isSecretariatResponse(scope)) return scope;
    const name = safeSecretariatText(body.name, 255);
    const title = safeSecretariatText(body.title, 150);
    if (!name || !title) return apiResponse(400, { error: 'Nome e função do signatário são obrigatórios.' });
    const memberId = safeSecretariatText(body.member_id, 36);
    if (memberId && !(await getScopedMember(scope, memberId))) return apiResponse(404, { error: 'Membro signatário não encontrado.' });
    const id = uuidv4();
    await query(`INSERT INTO document_signatories (
        id, organization_id, campus_id, member_id, name, title, signature_object_key, is_active, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`, [
      id, scope.organizationId, scope.campusId, memberId, name, title,
      safeSecretariatText(body.signature_object_key, 500), scope.user.userId
    ]);
    await logSecurityEvent({ organizationId: scope.organizationId, campusId: scope.campusId, user: scope.user,
      action: 'CREATE_DOCUMENT_SIGNATORY', resource: 'document_signatories', resourceId: id,
      details: { name, title, member_id: memberId }, event });
    return apiResponse(201, { message: 'Signatário cadastrado com sucesso.', id });
  } catch (error: any) {
    return errorResponse(error, 'Erro ao cadastrar signatário:');
  }
};

export const listDocuments = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const scope = await authorizeSecretariat(event, 'secretariat.view', {}, 'secretariat.documents');
    if (isSecretariatResponse(scope)) return scope;
    const campus = phase2CampusSql('idoc', scope.campusId);
    const result = await query(`SELECT idoc.*, m.name AS member_name, dt.name AS template_name
      FROM issued_documents idoc
      LEFT JOIN members m ON m.organization_id = idoc.organization_id AND m.id = idoc.member_id
      LEFT JOIN document_templates dt ON dt.organization_id = idoc.organization_id AND dt.id = idoc.template_id
      WHERE idoc.organization_id = ?${campus.clause}
      ORDER BY idoc.issued_at DESC LIMIT 200`, [scope.organizationId, ...campus.params]);
    return apiResponse(200, { data: result.rows.map((item: any) => ({ ...item, template_snapshot: parseStoredJson(item.template_snapshot) })) });
  } catch (error: any) {
    return errorResponse(error, 'Erro ao listar documentos:');
  }
};

export const issueDocument = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = parseBody(event);
    const scope = await authorizeSecretariat(event, 'secretariat.issue_documents', body, 'secretariat.documents');
    if (isSecretariatResponse(scope)) return scope;
    const memberId = safeSecretariatText(body.member_id, 36);
    const templateId = safeSecretariatText(body.template_id, 36);
    if (!memberId || !templateId) return apiResponse(400, { error: 'Membro e modelo são obrigatórios para emitir o documento.' });
    const member = await getScopedMember(scope, memberId);
    if (!member) return apiResponse(404, { error: 'Membro não encontrado nesta organização ou unidade.' });
    const templateResult = await query(`SELECT * FROM document_templates
      WHERE organization_id = ? AND id = ? AND is_active = 1${scope.campusId ? ' AND (campus_id IS NULL OR campus_id = ?)' : ''} LIMIT 1`,
    [scope.organizationId, templateId, ...(scope.campusId ? [scope.campusId] : [])]);
    const template = templateResult.rows[0];
    if (!template) return apiResponse(404, { error: 'Modelo não encontrado nesta organização.' });
    let signatory: any = null;
    const signatoryId = safeSecretariatText(body.signatory_id, 36);
    if (signatoryId) {
      const signatoryResult = await query(`SELECT id, name, title, signature_object_key FROM document_signatories
        WHERE organization_id = ? AND id = ? AND is_active = 1${scope.campusId ? ' AND (campus_id IS NULL OR campus_id = ?)' : ''} LIMIT 1`,
      [scope.organizationId, signatoryId, ...(scope.campusId ? [scope.campusId] : [])]);
      signatory = signatoryResult.rows[0];
      if (!signatory) return apiResponse(404, { error: 'Signatário não encontrado nesta organização.' });
    }
    const organization = await query(`SELECT id, name FROM organizations WHERE id = ? LIMIT 1`, [scope.organizationId]);
    const customFields = sanitizeFields(body.fields);
    const values: Record<string, string> = {
      member_name: member.name || '', member_email: member.email || '', member_phone: member.phone || '',
      registry_number: member.registry_number || '', membership_status: member.membership_status || '',
      baptism_date: member.baptism_date ? String(member.baptism_date).slice(0, 10) : '',
      organization_name: organization.rows[0]?.name || '',
      signatory_name: signatory?.name || '', signatory_title: signatory?.title || '',
      issue_date: new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      ...customFields
    };
    const schema = parseStoredJson(template.template_schema);
    const snapshot = { schema, rendered: renderTemplateValue(schema, values), values, signatory };
    const id = uuidv4();
    const prefix = String(template.document_type || 'DOC').split('_').map((part: string) => part[0]).join('').slice(0, 4);
    const documentNumber = `FH-${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${id.slice(0, 6).toUpperCase()}`;
    const requestId = safeSecretariatText(body.request_id, 36);
    if (requestId) {
      const request = await query(`SELECT id FROM secretariat_requests
        WHERE organization_id = ? AND id = ? AND member_id = ? LIMIT 1`, [scope.organizationId, requestId, memberId]);
      if (!request.rows.length) return apiResponse(404, { error: 'Solicitação vinculada não foi encontrada.' });
    }
    await query(`INSERT INTO issued_documents (
        id, organization_id, campus_id, member_id, request_id, template_id, document_type,
        document_number, template_version, template_snapshot, status, issued_by, approved_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VALID', ?, ?)`, [
      id, scope.organizationId, scope.campusId || member.campus_id, memberId, requestId, templateId,
      template.document_type, documentNumber, template.version, JSON.stringify(snapshot),
      scope.user.userId, scope.user.userId
    ]);
    if (requestId) {
      await query(`UPDATE secretariat_requests SET status = 'COMPLETED', approved_by = ?, approved_at = COALESCE(approved_at, NOW()),
          completed_at = NOW(), updated_at = NOW() WHERE organization_id = ? AND id = ?`,
      [scope.user.userId, scope.organizationId, requestId]);
    }
    await logSecurityEvent({ organizationId: scope.organizationId, campusId: member.campus_id, user: scope.user,
      action: 'ISSUE_SECRETARIAT_DOCUMENT', resource: 'issued_documents', resourceId: id,
      details: { member_id: memberId, document_type: template.document_type, document_number: documentNumber, template_version: template.version }, event });
    return apiResponse(201, { message: 'Documento emitido com sucesso.', data: { id, document_number: documentNumber, template_snapshot: snapshot, status: 'VALID' } });
  } catch (error: any) {
    return errorResponse(error, 'Erro ao emitir documento:');
  }
};

export const revokeDocument = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = parseBody(event);
    const scope = await authorizeSecretariat(event, 'secretariat.approve', body, 'secretariat.documents');
    if (isSecretariatResponse(scope)) return scope;
    const documentId = memberIdFromProxy(event.pathParameters?.proxy || '');
    const reason = safeSecretariatText(body.reason, 2000);
    if (!documentId || !reason) return apiResponse(400, { error: 'Informe o motivo do cancelamento.' });
    const campus = phase2CampusSql('issued_documents', scope.campusId);
    const result = await query(`UPDATE issued_documents SET status = 'REVOKED', revoked_by = ?, revoked_at = NOW(),
        revocation_reason = ?, updated_at = NOW()
      WHERE organization_id = ? AND id = ? AND status = 'VALID'${campus.clause}`,
    [scope.user.userId, reason, scope.organizationId, documentId, ...campus.params]);
    if (!(result.rows as any)?.affectedRows) return apiResponse(404, { error: 'Documento válido não encontrado nesta organização ou unidade.' });
    await logSecurityEvent({ organizationId: scope.organizationId, campusId: scope.campusId, user: scope.user,
      action: 'REVOKE_SECRETARIAT_DOCUMENT', resource: 'issued_documents', resourceId: documentId,
      details: { reason }, event });
    return apiResponse(200, { message: 'Documento cancelado com sucesso.', status: 'REVOKED' });
  } catch (error: any) {
    return errorResponse(error, 'Erro ao cancelar documento:');
  }
};

export async function handleSecretariatPhase2(
  event: APIGatewayProxyEvent,
  method: string,
  proxy: string
): Promise<APIGatewayProxyResult | null> {
  if (method === 'GET' && proxy === 'reference-data') return getReferenceData(event);
  if (method === 'GET' && proxy === 'movements') return listMovements(event);
  if (method === 'POST' && proxy === 'movements') return createMovement(event);
  if (method === 'PATCH' && /^movements\/[^/]+\/status$/.test(proxy)) return updateMovementStatus(event);
  if (method === 'GET' && proxy === 'requests') return listRequests(event);
  if (method === 'POST' && proxy === 'requests') return createRequest(event);
  if (method === 'PATCH' && /^requests\/[^/]+\/status$/.test(proxy)) return updateRequestStatus(event);
  if (method === 'GET' && proxy === 'baptisms') return listBaptisms(event);
  if (method === 'POST' && proxy === 'baptisms') return createBaptism(event);
  if (method === 'GET' && proxy === 'templates') return listTemplates(event);
  if (method === 'POST' && proxy === 'templates') return createTemplate(event);
  if (method === 'GET' && proxy === 'signatories') return listSignatories(event);
  if (method === 'POST' && proxy === 'signatories') return createSignatory(event);
  if (method === 'GET' && proxy === 'documents') return listDocuments(event);
  if (method === 'POST' && proxy === 'documents') return issueDocument(event);
  if (method === 'PATCH' && /^documents\/[^/]+\/status$/.test(proxy)) return revokeDocument(event);
  return null;
}
