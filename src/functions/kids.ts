import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';
import { randomUUID } from 'crypto';

// Helper para gerar código de segurança de 4 dígitos aleatório com prefixo
function generateSecurityCode(): string {
  const num = Math.floor(1000 + Math.random() * 9000);
  return `K-${num}`;
}

// Salas Padrão para novas congregações
const DEFAULT_ROOMS = [
  { name: "Berçário (0 a 2 anos)", min_age: 0, max_age: 2, capacity: 15, color: "#ec4899", icon: "🍼", description: "Bebês de colo e engatinhantes" },
  { name: "Maternal (3 a 5 anos)", min_age: 3, max_age: 5, capacity: 25, color: "#f59e0b", icon: "🧸", description: "Primeira infância e atividades lúdicas" },
  { name: "Kids I (6 a 8 anos)", min_age: 6, max_age: 8, capacity: 30, color: "#0f766e", icon: "🎨", description: "Histórias bíblicas, teatro e dinâmicas" },
  { name: "Juniores (9 a 11 anos)", min_age: 9, max_age: 11, capacity: 30, color: "#6366f1", icon: "🚀", description: "Estudos bíblicos aprofundados e louvor" }
];

// ==========================================
// 1. GET & POST /kids/rooms
// ==========================================
export const getRooms = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const orgId = event.queryStringParameters?.organization_id || 'org_default';
    const campusId = event.queryStringParameters?.campus_id;

    let sql = `SELECT * FROM kids_rooms WHERE organization_id = ?`;
    const params: any[] = [orgId];

    if (campusId && campusId !== 'all') {
      sql += ` AND (campus_id = ? OR campus_id IS NULL)`;
      params.push(campusId);
    }
    sql += ` ORDER BY min_age ASC`;

    const { rows } = await query(sql, params);

    // Se a organização ainda não tiver salas cadastradas, provisiona as salas padrão
    if (rows.length === 0) {
      for (const r of DEFAULT_ROOMS) {
        const id = `room_${randomUUID().substring(0, 8)}`;
        await query(
          `INSERT INTO kids_rooms (id, name, min_age, max_age, capacity, color, icon, description, organization_id, campus_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, r.name, r.min_age, r.max_age, r.capacity, r.color, r.icon, r.description, orgId, campusId || null]
        );
      }
      const { rows: newRows } = await query(sql, params);
      return apiResponse(200, { data: newRows });
    }

    return apiResponse(200, { data: rows });
  } catch (error: any) {
    console.error('Erro ao listar salas do Kids:', error);
    return apiResponse(500, { message: 'Erro ao listar salas', error: error.message });
  }
};

export const saveRoom = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { id, name, min_age, max_age, capacity, color, icon, description, organization_id, campus_id } = body;

    if (!name || !organization_id) {
      return apiResponse(400, { message: 'Nome da sala e organização são obrigatórios' });
    }

    const roomId = id || `room_${randomUUID().substring(0, 8)}`;

    const sql = `
      INSERT INTO kids_rooms (id, name, min_age, max_age, capacity, color, icon, description, organization_id, campus_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        min_age = VALUES(min_age),
        max_age = VALUES(max_age),
        capacity = VALUES(capacity),
        color = VALUES(color),
        icon = VALUES(icon),
        description = VALUES(description),
        campus_id = VALUES(campus_id),
        updated_at = NOW()
    `;

    await query(sql, [
      roomId,
      name,
      min_age || 0,
      max_age || 12,
      capacity || 30,
      color || '#0f766e',
      icon || '👶',
      description || null,
      organization_id,
      campus_id || null
    ]);

    return apiResponse(200, { message: 'Sala salva com sucesso!', id: roomId });
  } catch (error: any) {
    console.error('Erro ao salvar sala do Kids:', error);
    return apiResponse(500, { message: 'Erro ao salvar sala', error: error.message });
  }
};

// ==========================================
// 2. GET & POST /kids/children
// ==========================================
export const getChildren = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const orgId = event.queryStringParameters?.organization_id || 'org_default';
    const search = event.queryStringParameters?.search;
    const campusId = event.queryStringParameters?.campus_id;

    let sql = `SELECT * FROM kids_children WHERE organization_id = ?`;
    const params: any[] = [orgId];

    if (campusId && campusId !== 'all') {
      sql += ` AND (campus_id = ? OR campus_id IS NULL)`;
      params.push(campusId);
    }

    if (search) {
      sql += ` AND (name LIKE ? OR parent_name LIKE ? OR parent_phone LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ` ORDER BY name ASC LIMIT 100`;

    const { rows } = await query(sql, params);
    return apiResponse(200, { data: rows });
  } catch (error: any) {
    console.error('Erro ao listar crianças:', error);
    return apiResponse(500, { message: 'Erro ao listar crianças', error: error.message });
  }
};

export const saveChild = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const {
      id,
      name,
      birthdate,
      gender,
      allergies,
      medical_notes,
      general_notes,
      parent_name,
      parent_phone,
      parent_email,
      emergency_contact,
      emergency_phone,
      photo_url,
      organization_id,
      campus_id
    } = body;

    if (!name || !parent_name || !parent_phone || !organization_id) {
      return apiResponse(400, { message: 'Nome da criança, nome do responsável, telefone e organização são obrigatórios' });
    }

    const childId = id || `child_${randomUUID()}`;

    const sql = `
      INSERT INTO kids_children (
        id, name, birthdate, gender, allergies, medical_notes, general_notes,
        parent_name, parent_phone, parent_email, emergency_contact, emergency_phone,
        photo_url, organization_id, campus_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        birthdate = VALUES(birthdate),
        gender = VALUES(gender),
        allergies = VALUES(allergies),
        medical_notes = VALUES(medical_notes),
        general_notes = VALUES(general_notes),
        parent_name = VALUES(parent_name),
        parent_phone = VALUES(parent_phone),
        parent_email = VALUES(parent_email),
        emergency_contact = VALUES(emergency_contact),
        emergency_phone = VALUES(emergency_phone),
        photo_url = VALUES(photo_url),
        campus_id = VALUES(campus_id),
        updated_at = NOW()
    `;

    await query(sql, [
      childId,
      name,
      birthdate || null,
      gender || 'M',
      allergies || null,
      medical_notes || null,
      general_notes || null,
      parent_name,
      parent_phone,
      parent_email || null,
      emergency_contact || null,
      emergency_phone || null,
      photo_url || null,
      organization_id,
      campus_id || null
    ]);

    return apiResponse(200, { message: 'Criança cadastrada com sucesso!', id: childId });
  } catch (error: any) {
    console.error('Erro ao salvar cadastro de criança:', error);
    return apiResponse(500, { message: 'Erro ao cadastrar criança', error: error.message });
  }
};

// ==========================================
// 3. GET /kids/checkins & POST /kids/checkin
// ==========================================
export const getCheckins = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const orgId = event.queryStringParameters?.organization_id || 'org_default';
    const status = event.queryStringParameters?.status; // 'active', 'CHECKED_IN', 'CALLING_PARENTS', 'CHECKED_OUT'
    const roomId = event.queryStringParameters?.room_id;
    const campusId = event.queryStringParameters?.campus_id;
    const childId = event.queryStringParameters?.child_id;

    let sql = `
      SELECT 
        c.*,
        ch.birthdate,
        ch.allergies,
        ch.medical_notes,
        ch.general_notes,
        ch.photo_url,
        r.color as room_color,
        r.icon as room_icon
      FROM kids_checkins c
      LEFT JOIN kids_children ch ON c.child_id = ch.id
      LEFT JOIN kids_rooms r ON c.room_id = r.id
      WHERE c.organization_id = ?
    `;
    const params: any[] = [orgId];

    if (status === 'active') {
      sql += ` AND c.status IN ('CHECKED_IN', 'CALLING_PARENTS')`;
    } else if (status) {
      sql += ` AND c.status = ?`;
      params.push(status);
    }

    if (roomId && roomId !== 'all') {
      sql += ` AND c.room_id = ?`;
      params.push(roomId);
    }

    if (campusId && campusId !== 'all') {
      sql += ` AND (c.campus_id = ? OR c.campus_id IS NULL)`;
      params.push(campusId);
    }

    if (childId) {
      sql += ` AND c.child_id = ?`;
      params.push(childId);
    }

    sql += ` ORDER BY c.status = 'CALLING_PARENTS' DESC, c.checkin_at DESC`;

    const { rows } = await query(sql, params);
    return apiResponse(200, { data: rows });
  } catch (error: any) {
    console.error('Erro ao buscar check-ins do Kids:', error);
    return apiResponse(500, { message: 'Erro ao buscar check-ins', error: error.message });
  }
};

export const doCheckin = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const {
      child_id,
      child_name,
      birthdate,
      allergies,
      medical_notes,
      room_id,
      room_name,
      parent_name,
      parent_phone,
      parent_email,
      checked_in_by,
      organization_id,
      campus_id
    } = body;

    if (!child_name || !room_id || !parent_name || !parent_phone || !organization_id) {
      return apiResponse(400, { message: 'Dados insuficientes para realizar o check-in' });
    }

    let finalChildId = child_id;

    // Se a criança não existir no cadastro, cadastra automaticamente
    if (!finalChildId) {
      finalChildId = `child_${randomUUID()}`;
      await query(
        `INSERT INTO kids_children (id, name, birthdate, allergies, medical_notes, parent_name, parent_phone, parent_email, organization_id, campus_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [finalChildId, child_name, birthdate || null, allergies || null, medical_notes || null, parent_name, parent_phone, parent_email || null, organization_id, campus_id || null]
      );
    }

    // Verifica se a criança já possui check-in ativo hoje
    const { rows: activeCheckins } = await query(
      `SELECT id FROM kids_checkins WHERE child_id = ? AND status IN ('CHECKED_IN', 'CALLING_PARENTS') LIMIT 1`,
      [finalChildId]
    );
    if (activeCheckins.length > 0) {
      return apiResponse(400, { message: 'Esta criança já possui um check-in ativo na sala!' });
    }

    // Busca nome da sala se não informado
    let finalRoomName = room_name;
    if (!finalRoomName) {
      const { rows: roomRows } = await query(`SELECT name FROM kids_rooms WHERE id = ? LIMIT 1`, [room_id]);
      finalRoomName = roomRows[0]?.name || 'Sala Kids';
    }

    const checkinId = `checkin_${randomUUID()}`;
    const securityCode = generateSecurityCode();

    const sql = `
      INSERT INTO kids_checkins (
        id, child_id, child_name, room_id, room_name,
        parent_name, parent_phone, security_code, status,
        checkin_at, checked_in_by, organization_id, campus_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CHECKED_IN', NOW(), ?, ?, ?)
    `;

    await query(sql, [
      checkinId,
      finalChildId,
      child_name,
      room_id,
      finalRoomName,
      parent_name,
      parent_phone,
      securityCode,
      checked_in_by || 'Recepção Kids',
      organization_id,
      campus_id || null
    ]);

    return apiResponse(200, {
      message: 'Check-in realizado com sucesso!',
      checkin: {
        id: checkinId,
        child_id: finalChildId,
        child_name,
        room_id,
        room_name: finalRoomName,
        parent_name,
        parent_phone,
        security_code: securityCode,
        status: 'CHECKED_IN',
        checkin_at: new Date().toISOString()
      }
    });
  } catch (error: any) {
    console.error('Erro ao realizar check-in:', error);
    return apiResponse(500, { message: 'Erro ao realizar check-in', error: error.message });
  }
};

// ==========================================
// 4. POST /kids/call-parent & POST /kids/resolve-call
// ==========================================
export const callParent = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { checkin_id, reason, message } = body;

    if (!checkin_id || !reason) {
      return apiResponse(400, { message: 'checkin_id e motivo da chamada são obrigatórios' });
    }

    const sql = `
      UPDATE kids_checkins
      SET status = 'CALLING_PARENTS',
          call_reason = ?,
          call_message = ?,
          called_at = NOW()
      WHERE id = ?
    `;

    await query(sql, [reason, message || null, checkin_id]);

    return apiResponse(200, {
      message: 'Chamada do responsável disparada com sucesso!',
      status: 'CALLING_PARENTS'
    });
  } catch (error: any) {
    console.error('Erro ao acionar chamada de pais:', error);
    return apiResponse(500, { message: 'Erro ao acionar chamada de pais', error: error.message });
  }
};

export const resolveCall = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { checkin_id } = body;

    if (!checkin_id) {
      return apiResponse(400, { message: 'checkin_id é obrigatório' });
    }

    const sql = `
      UPDATE kids_checkins
      SET status = 'CHECKED_IN',
          call_reason = NULL,
          call_message = NULL
      WHERE id = ?
    `;

    await query(sql, [checkin_id]);

    return apiResponse(200, {
      message: 'Chamado atendido e retornado para status normal!',
      status: 'CHECKED_IN'
    });
  } catch (error: any) {
    console.error('Erro ao resolver chamado:', error);
    return apiResponse(500, { message: 'Erro ao resolver chamado', error: error.message });
  }
};

// ==========================================
// 5. POST /kids/checkout
// ==========================================
export const doCheckout = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { checkin_id, security_code, checked_out_by, force_checkout } = body;

    if (!checkin_id) {
      return apiResponse(400, { message: 'checkin_id é obrigatório' });
    }

    // Busca o checkin atual
    const { rows } = await query(`SELECT * FROM kids_checkins WHERE id = ? LIMIT 1`, [checkin_id]);
    if (rows.length === 0) {
      return apiResponse(404, { message: 'Registro de check-in não encontrado' });
    }

    const checkin = rows[0];

    if (checkin.status === 'CHECKED_OUT') {
      return apiResponse(400, { message: 'Esta criança já foi retirada anteriormente!' });
    }

    // Validação do PIN de Segurança
    if (!force_checkout) {
      const cleanInputPin = (security_code || '').trim().toUpperCase().replace('#', '');
      const cleanDbPin = (checkin.security_code || '').trim().toUpperCase().replace('#', '');

      if (cleanInputPin !== cleanDbPin && cleanInputPin !== cleanDbPin.replace('K-', '')) {
        return apiResponse(400, {
          message: `Código de segurança inválido! O código correto é ${checkin.security_code}. Digite o PIN correto do crachá do responsável para liberar a criança.`
        });
      }
    }

    const sql = `
      UPDATE kids_checkins
      SET status = 'CHECKED_OUT',
          checkout_at = NOW(),
          checked_out_by = ?
      WHERE id = ?
    `;

    await query(sql, [checked_out_by || 'Voluntário da Sala', checkin_id]);

    return apiResponse(200, {
      message: `Checkout de ${checkin.child_name} realizado com segurança!`,
      status: 'CHECKED_OUT'
    });
  } catch (error: any) {
    console.error('Erro ao realizar checkout:', error);
    return apiResponse(500, { message: 'Erro ao realizar checkout', error: error.message });
  }
};

// ==========================================
// 6. GET /kids/parent-status (Para o PWA dos Pais)
// ==========================================
export const getParentStatus = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const parentPhone = event.queryStringParameters?.phone;
    const orgId = event.queryStringParameters?.organization_id || 'org_default';

    if (!parentPhone) {
      return apiResponse(200, { active_checkins: [] });
    }

    // Normaliza telefone (remove caracteres especiais)
    const cleanPhone = parentPhone.replace(/\D/g, '');

    const sql = `
      SELECT 
        c.*,
        ch.allergies,
        ch.medical_notes,
        ch.photo_url,
        r.color as room_color,
        r.icon as room_icon
      FROM kids_checkins c
      LEFT JOIN kids_children ch ON c.child_id = ch.id
      LEFT JOIN kids_rooms r ON c.room_id = r.id
      WHERE c.organization_id = ?
        AND c.status IN ('CHECKED_IN', 'CALLING_PARENTS')
        AND (
          REPLACE(REPLACE(REPLACE(REPLACE(c.parent_phone, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?
          OR c.parent_phone LIKE ?
        )
      ORDER BY c.checkin_at DESC
    `;

    const { rows } = await query(sql, [orgId, `%${cleanPhone.slice(-8)}%`, `%${parentPhone}%`]);

    return apiResponse(200, { active_checkins: rows });
  } catch (error: any) {
    console.error('Erro ao consultar status dos filhos para o responsável:', error);
    return apiResponse(500, { message: 'Erro ao consultar status', error: error.message });
  }
};

// ==========================================
// UNIFIED ROUTER HANDLER
// ==========================================
export const kidsHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = (event.requestContext?.http?.method || event.httpMethod || '').toUpperCase();
  const rawPath = event.requestContext?.http?.path || event.path || '';

  if (rawPath.includes('/kids/rooms')) {
    if (method === 'GET') return getRooms(event);
    if (method === 'POST') return saveRoom(event);
  }
  if (rawPath.includes('/kids/children')) {
    if (method === 'GET') return getChildren(event);
    if (method === 'POST') return saveChild(event);
  }
  if (rawPath.includes('/kids/checkins')) {
    if (method === 'GET') return getCheckins(event);
  }
  if (rawPath.includes('/kids/checkin')) {
    if (method === 'POST') return doCheckin(event);
  }
  if (rawPath.includes('/kids/call-parent')) {
    if (method === 'POST') return callParent(event);
  }
  if (rawPath.includes('/kids/resolve-call')) {
    if (method === 'POST') return resolveCall(event);
  }
  if (rawPath.includes('/kids/checkout')) {
    if (method === 'POST') return doCheckout(event);
  }
  if (rawPath.includes('/kids/parent-status')) {
    if (method === 'GET') return getParentStatus(event);
  }

  return apiResponse(404, { message: 'Rota Kids não encontrada' });
};

