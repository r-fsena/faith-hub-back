import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { query, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant, getAuthenticatedUser } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';

const STUDY_ADMIN_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER'];

// ============================================================================
// 1. GET /study-books -> Listar Livros/Séries de Estudos
// ============================================================================
export const getStudyBooks = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = await getAuthenticatedUser(event);
    const requestedOrgId = event.queryStringParameters?.organization_id;
    const campusId = event.queryStringParameters?.campus_id;
    const groupId = event.queryStringParameters?.group_id;

    const orgId = user ? enforceTenant(user, requestedOrgId).effectiveOrgId : (requestedOrgId || 'org_default');

    let q = `
      SELECT sb.*, 
        cg.name AS target_group_name,
        COUNT(sc.id) AS chapter_count,
        MIN(sc.scheduled_date) AS first_scheduled_date,
        MAX(sc.scheduled_date) AS last_scheduled_date
      FROM study_books sb
      LEFT JOIN cell_groups cg ON sb.target_group_id = cg.id
      LEFT JOIN study_chapters sc ON sb.id = sc.book_id
      WHERE (sb.organization_id = ? OR sb.organization_id IS NULL)
    `;
    const params: any[] = [orgId];

    if (campusId && campusId !== 'all') {
      q += ` AND (sb.campus_id = ? OR sb.campus_id IS NULL)`;
      params.push(campusId);
    }

    if (groupId) {
      q += ` AND (sb.target_group_id IS NULL OR sb.target_group_id = ?)`;
      params.push(groupId);
    }

    // Se for rota pública ou membro comum no PWA, filtra ativos
    const isPublicOrMember = !user || user.role === 'MEMBER' || user.role === 'VOLUNTEER';
    if (isPublicOrMember) {
      q += ` AND sb.status = 'ACTIVE'`;
    }

    q += ` GROUP BY sb.id ORDER BY sb.created_at DESC`;

    const { rows } = await query(q, params);
    return apiResponse(200, rows);
  } catch (err: any) {
    console.error('Erro ao listar livros de estudo:', err);
    return apiResponse(500, { error: 'Erro ao listar livros de estudo' });
  }
};

// ============================================================================
// 2. GET /study-books/{id} -> Detalhes do Livro + Capítulos Ordenados
// ============================================================================
export const getStudyBookById = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID do livro é obrigatório' });

    const { rows: bookRows } = await query(
      `SELECT sb.*, cg.name AS target_group_name 
       FROM study_books sb
       LEFT JOIN cell_groups cg ON sb.target_group_id = cg.id
       WHERE sb.id = ? LIMIT 1`,
      [id]
    );

    if (bookRows.length === 0) {
      return apiResponse(404, { message: 'Livro de estudo não encontrado' });
    }

    const book = bookRows[0];

    const { rows: chapterRows } = await query(
      `SELECT * FROM study_chapters WHERE book_id = ? ORDER BY chapter_number ASC, scheduled_date ASC`,
      [id]
    );

    const parsedChapters = chapterRows.map(ch => ({
      ...ch,
      discussion_questions: typeof ch.discussion_questions === 'string' 
        ? JSON.parse(ch.discussion_questions || '[]') 
        : (ch.discussion_questions || [])
    }));

    return apiResponse(200, {
      ...book,
      chapters: parsedChapters
    });
  } catch (err: any) {
    console.error('Erro ao carregar livro de estudo:', err);
    return apiResponse(500, { error: 'Erro ao carregar livro de estudo' });
  }
};

// ============================================================================
// 3. POST /study-books -> Criar ou Atualizar Livro e seus Capítulos
// ============================================================================
export const createOrUpdateStudyBook = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, STUDY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const {
      id,
      title,
      subtitle,
      preface,
      author_name,
      cover_color,
      cover_url,
      target_group_id,
      status,
      organization_id,
      campus_id,
      chapters
    } = body;

    if (!title) {
      return apiResponse(400, { error: 'Título do livro é obrigatório' });
    }

    const tenantCheck = enforceTenant(auth.user, organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgValue = tenantCheck.effectiveOrgId;

    const finalId = id || uuidv4();
    const campusValue = campus_id || 'campus_sede';
    const statusValue = status || 'ACTIVE';
    const colorValue = cover_color || 'linear-gradient(135deg, #1e3a8a, #3b82f6)';

    const q = `
      INSERT INTO study_books (
        id, organization_id, campus_id, target_group_id, title, subtitle,
        preface, author_name, cover_color, cover_url, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        campus_id = VALUES(campus_id),
        target_group_id = VALUES(target_group_id),
        title = VALUES(title),
        subtitle = VALUES(subtitle),
        preface = VALUES(preface),
        author_name = VALUES(author_name),
        cover_color = VALUES(cover_color),
        cover_url = VALUES(cover_url),
        status = VALUES(status),
        updated_at = NOW()
    `;

    await query(q, [
      finalId,
      orgValue,
      campusValue,
      target_group_id || null,
      title,
      subtitle || null,
      preface || null,
      author_name || auth.user.name || 'Pastor da Comunidade',
      colorValue,
      cover_url || null,
      statusValue
    ]);

    // Se capítulos foram passados no payload, processa-os
    if (Array.isArray(chapters)) {
      for (let i = 0; i < chapters.length; i++) {
        const ch = chapters[i];
        const chapterId = ch.id || uuidv4();
        const chapterNum = ch.chapter_number || (i + 1);
        const questionsJson = Array.isArray(ch.discussion_questions) 
          ? JSON.stringify(ch.discussion_questions) 
          : (typeof ch.discussion_questions === 'string' ? ch.discussion_questions : null);

        await query(`
          INSERT INTO study_chapters (
            id, book_id, chapter_number, title, verse_reference, icebreaker,
            content_text, discussion_questions, practical_challenge, media_type,
            media_link, scheduled_date, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            chapter_number = VALUES(chapter_number),
            title = VALUES(title),
            verse_reference = VALUES(verse_reference),
            icebreaker = VALUES(icebreaker),
            content_text = VALUES(content_text),
            discussion_questions = VALUES(discussion_questions),
            practical_challenge = VALUES(practical_challenge),
            media_type = VALUES(media_type),
            media_link = VALUES(media_link),
            scheduled_date = VALUES(scheduled_date),
            status = VALUES(status),
            updated_at = NOW()
        `, [
          chapterId,
          finalId,
          chapterNum,
          ch.title || `Capítulo ${chapterNum}`,
          ch.verse_reference || null,
          ch.icebreaker || null,
          ch.content_text || '',
          questionsJson,
          ch.practical_challenge || null,
          ch.media_type || 'NONE',
          ch.media_link || null,
          ch.scheduled_date || null,
          ch.status || 'ACTIVE'
        ]);
      }
    }

    await logSecurityEvent({
      organizationId: orgValue,
      user: auth.user,
      action: id ? 'UPDATE_STUDY_BOOK' : 'CREATE_STUDY_BOOK',
      resource: 'study_books',
      resourceId: finalId,
      details: { title, target_group_id, chapter_count: chapters?.length || 0 },
      event
    });

    return apiResponse(id ? 200 : 201, { message: 'Livro de estudo salvo com sucesso', id: finalId });
  } catch (err: any) {
    console.error('Erro ao salvar livro de estudo:', err);
    return apiResponse(500, { error: 'Erro ao salvar livro de estudo' });
  }
};

// ============================================================================
// 4. DELETE /study-books/{id} -> Deletar Livro e seus Capítulos
// ============================================================================
export const deleteStudyBook = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN']);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const id = event.pathParameters?.id;
    if (!id) return apiResponse(400, { error: 'ID faltante' });

    const { rows } = await query(`SELECT organization_id, title FROM study_books WHERE id = ? LIMIT 1`, [id]);
    if (rows.length === 0) return apiResponse(404, { message: 'Livro de estudo não encontrado' });

    const tenantCheck = enforceTenant(auth.user, rows[0].organization_id);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;

    await query(`DELETE FROM study_books WHERE id = ?`, [id]);

    await logSecurityEvent({
      organizationId: tenantCheck.effectiveOrgId,
      user: auth.user,
      action: 'DELETE_STUDY_BOOK',
      resource: 'study_books',
      resourceId: id,
      details: { title: rows[0].title },
      event
    });

    return apiResponse(200, { message: 'Livro de estudo deletado com sucesso' });
  } catch (err: any) {
    console.error('Erro ao deletar livro de estudo:', err);
    return apiResponse(500, { error: 'Erro ao deletar livro de estudo' });
  }
};

// ============================================================================
// 5. POST /study-books/{id}/chapters -> Adicionar/Editar Capítulo Individual
// ============================================================================
export const saveStudyChapter = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, STUDY_ADMIN_ROLES);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const bookId = event.pathParameters?.id;
    if (!bookId) return apiResponse(400, { error: 'ID do livro é obrigatório' });

    const body = JSON.parse(event.body || '{}');
    const {
      id,
      chapter_number,
      title,
      verse_reference,
      icebreaker,
      content_text,
      discussion_questions,
      practical_challenge,
      media_type,
      media_link,
      scheduled_date,
      status
    } = body;

    const finalId = id || uuidv4();
    const questionsJson = Array.isArray(discussion_questions) 
      ? JSON.stringify(discussion_questions) 
      : (typeof discussion_questions === 'string' ? discussion_questions : null);

    await query(`
      INSERT INTO study_chapters (
        id, book_id, chapter_number, title, verse_reference, icebreaker,
        content_text, discussion_questions, practical_challenge, media_type,
        media_link, scheduled_date, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        chapter_number = VALUES(chapter_number),
        title = VALUES(title),
        verse_reference = VALUES(verse_reference),
        icebreaker = VALUES(icebreaker),
        content_text = VALUES(content_text),
        discussion_questions = VALUES(discussion_questions),
        practical_challenge = VALUES(practical_challenge),
        media_type = VALUES(media_type),
        media_link = VALUES(media_link),
        scheduled_date = VALUES(scheduled_date),
        status = VALUES(status),
        updated_at = NOW()
    `, [
      finalId,
      bookId,
      chapter_number || 1,
      title || 'Novo Capítulo',
      verse_reference || null,
      icebreaker || null,
      content_text || '',
      questionsJson,
      practical_challenge || null,
      media_type || 'NONE',
      media_link || null,
      scheduled_date || null,
      status || 'ACTIVE'
    ]);

    return apiResponse(200, { message: 'Capítulo salvo com sucesso', id: finalId });
  } catch (err: any) {
    console.error('Erro ao salvar capítulo:', err);
    return apiResponse(500, { error: 'Erro ao salvar capítulo' });
  }
};

// ============================================================================
// 6. DELETE /study-books/{id}/chapters/{chapterId} -> Remover Capítulo
// ============================================================================
export const deleteStudyChapter = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN']);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const chapterId = event.pathParameters?.chapterId;
    if (!chapterId) return apiResponse(400, { error: 'ID do capítulo faltante' });

    await query(`DELETE FROM study_chapters WHERE id = ?`, [chapterId]);
    return apiResponse(200, { message: 'Capítulo removido com sucesso' });
  } catch (err: any) {
    console.error('Erro ao deletar capítulo:', err);
    return apiResponse(500, { error: 'Erro ao deletar capítulo' });
  }
};

// ============================================================================
// 7. COMPATIBILIDADE LEGADA: GET /studies, POST /studies, DELETE /studies
// ============================================================================
export const createOrUpdateStudy = createOrUpdateStudyBook;
export const getStudies = getStudyBooks;
export const deleteStudy = deleteStudyBook;
