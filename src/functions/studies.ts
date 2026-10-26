import { authorizeResource } from '../services/tenantResource';
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

    const tenantScope = user ? enforceTenant(user, requestedOrgId) : null;
    if (tenantScope && !tenantScope.allowed) return tenantScope.errorResponse!;
    const orgId = tenantScope?.effectiveOrgId || (requestedOrgId || 'org_default');

    let q = `
      SELECT sb.*, 
        cg.name AS target_group_name,
        COUNT(sc.id) AS chapter_count,
        MIN(sc.scheduled_date) AS first_scheduled_date,
        MAX(sc.scheduled_date) AS last_scheduled_date
      FROM study_books sb
      LEFT JOIN cell_groups cg ON sb.target_group_id = cg.id
      LEFT JOIN study_chapters sc ON sb.id = sc.book_id
      WHERE sb.organization_id = ?
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
    const parsedBooks = rows.map(b => ({
      ...b,
      first_scheduled_date: b.first_scheduled_date 
        ? (b.first_scheduled_date instanceof Date ? b.first_scheduled_date.toISOString().split('T')[0] : String(b.first_scheduled_date).split('T')[0])
        : null,
      last_scheduled_date: b.last_scheduled_date
        ? (b.last_scheduled_date instanceof Date ? b.last_scheduled_date.toISOString().split('T')[0] : String(b.last_scheduled_date).split('T')[0])
        : null
    }));
    return apiResponse(200, parsedBooks);
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

    const user = await getAuthenticatedUser(event);
    const userId = user?.userId;
    const tenantCheck = user ? enforceTenant(user, event.queryStringParameters?.organization_id) : null;
    if (tenantCheck && !tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgId = tenantCheck?.effectiveOrgId || event.queryStringParameters?.organization_id || 'org_default';

    const { rows: bookRows } = await query(
      `SELECT sb.*, cg.name AS target_group_name 
       FROM study_books sb
       LEFT JOIN cell_groups cg ON sb.target_group_id = cg.id
       WHERE sb.id = ? AND sb.organization_id = ? LIMIT 1`,
      [id, orgId]
    );

    if (bookRows.length === 0) {
      return apiResponse(404, { message: 'Livro de estudo não encontrado' });
    }

    const book = bookRows[0];
    const canEdit = user && (user.isSuperAdmin || STUDY_ADMIN_ROLES.includes(user.role));
    if (!canEdit && book.status !== 'ACTIVE') return apiResponse(404, { message: 'Livro indisponível' });

    const { rows: chapterRows } = await query(
      `SELECT c.* FROM study_chapters c JOIN study_books b ON b.id = c.book_id WHERE c.book_id = ? AND b.organization_id = ? AND (? = 1 OR c.status = 'ACTIVE') ORDER BY c.chapter_number ASC, c.scheduled_date ASC`,
      [id, orgId, canEdit ? 1 : 0]
    );

    let completedChapterIds: string[] = [];
    if (userId) {
      const { rows: compRows } = await query(
        `SELECT chapter_id FROM study_chapter_completions WHERE user_id = ? AND book_id = ? AND organization_id = ?`,
        [userId, id, orgId]
      );
      completedChapterIds = compRows.map(r => r.chapter_id);
    }

    const parsedChapters = chapterRows.map((ch, idx) => {
      let schedDate: string | null = null;
      if (ch.scheduled_date) {
        if (ch.scheduled_date instanceof Date) {
          schedDate = ch.scheduled_date.toISOString().split('T')[0];
        } else if (typeof ch.scheduled_date === 'string') {
          schedDate = ch.scheduled_date.split('T')[0];
        }
      }

      // Se data for nula, vazia ou começar com '0000': calcula a partir de hoje a cada 1 semana
      if (!schedDate || schedDate.startsWith('0000') || schedDate === 'null') {
        const d = new Date();
        d.setDate(d.getDate() + (idx * 7));
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        schedDate = `${y}-${m}-${day}`;
      }

      return {
        ...ch,
        scheduled_date: schedDate,
        completed: completedChapterIds.includes(ch.id),
        discussion_questions: typeof ch.discussion_questions === 'string' 
          ? JSON.parse(ch.discussion_questions || '[]') 
          : (ch.discussion_questions || [])
      };
    });

    return apiResponse(200, {
      ...book,
      chapters: parsedChapters,
      completed_chapter_ids: completedChapterIds
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
    if (id) {
      const resource = await authorizeResource({ ...event, headers: { ...event.headers, 'x-organization-id': orgValue } }, 'study_books', id);
      if ('errorResponse' in resource) return resource.errorResponse;
    }

    const finalId = id || uuidv4();
    const campusValue = campus_id || 'campus_sede';
    const statusValue = status || 'ACTIVE';
    const colorValue = cover_color || 'linear-gradient(135deg, #1e3a8a, #3b82f6)';

    const notifyMembers = body.notify_members ? 1 : 0;

    const q = `
      INSERT INTO study_books (
        id, organization_id, campus_id, target_group_id, title, subtitle,
        preface, author_name, cover_color, cover_url, status, notify_members, notification_sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN NOW() ELSE NULL END)
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
        notify_members = VALUES(notify_members),
        notification_sent_at = CASE WHEN VALUES(notify_members) = 1 AND notification_sent_at IS NULL THEN NOW() ELSE notification_sent_at END,
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
      statusValue,
      notifyMembers,
      notifyMembers
    ]);

    // Se capítulos foram passados no payload, processa-os
    if (Array.isArray(chapters)) {
      for (let i = 0; i < chapters.length; i++) {
        const ch = chapters[i];
        let chapterId = uuidv4();
        if (ch.id) {
          const { rows: owned } = await query('SELECT c.id FROM study_chapters c JOIN study_books b ON b.id = c.book_id WHERE c.id = ? AND c.book_id = ? AND b.organization_id = ?', [ch.id, finalId, orgValue]);
          if (owned.length) chapterId = owned[0].id;
        }
        const chapterNum = ch.chapter_number || (i + 1);
        const questionsJson = Array.isArray(ch.discussion_questions) 
          ? JSON.stringify(ch.discussion_questions) 
          : (typeof ch.discussion_questions === 'string' ? ch.discussion_questions : null);

        let chapterDate = ch.scheduled_date ? String(ch.scheduled_date).split('T')[0] : null;
        if (!chapterDate || chapterDate.startsWith('0000') || chapterDate === 'null') {
          const d = new Date();
          d.setDate(d.getDate() + (i * 7));
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          chapterDate = `${y}-${m}-${day}`;
        }

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
          chapterDate,
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

    const scope = await authorizeResource(event, 'study_books', bookId, STUDY_ADMIN_ROLES);
    if ('errorResponse' in scope) return scope.errorResponse;
    if (id) {
      const chapter = await authorizeResource(event, 'study_chapters', id, STUDY_ADMIN_ROLES);
      if ('errorResponse' in chapter) return chapter.errorResponse;
      if (chapter.record.book_id !== bookId) return apiResponse(403, { error: 'Capítulo pertence a outro livro' });
    }
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

    const scope = await authorizeResource(event, 'study_chapters', chapterId, ['SUPERADMIN', 'PASTOR', 'ADMIN']);
    if ('errorResponse' in scope) return scope.errorResponse;
    if (scope.record.book_id !== event.pathParameters?.id) return apiResponse(404, { error: 'Capítulo não encontrado' });
    await query(`DELETE c FROM study_chapters c JOIN study_books b ON b.id = c.book_id WHERE c.id = ? AND b.organization_id = ?`, [chapterId, scope.organizationId]);
    await logSecurityEvent({ organizationId: scope.organizationId, user: auth.user, action: 'DELETE_STUDY_CHAPTER', resource: 'study_chapters', resourceId: chapterId, event });
    return apiResponse(200, { message: 'Capítulo removido com sucesso' });
  } catch (err: any) {
    console.error('Erro ao deletar capítulo:', err);
    return apiResponse(500, { error: 'Erro ao deletar capítulo' });
  }
};

// ============================================================================
// 7. POST /study-chapters/{id}/toggle-completion -> Alternar Conclusão do Capítulo
// ============================================================================
export const toggleChapterCompletion = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const chapterId = event.pathParameters?.id;
  if (!chapterId) return apiResponse(400, { error: 'Capítulo obrigatório' });
  const scope = await authorizeResource(event, 'study_chapters', chapterId);
  if ('errorResponse' in scope) return scope.errorResponse;
  const userId = scope.user.userId;
  const orgId = scope.organizationId;
  const bookId = scope.record.book_id;
  const { rows } = await query('SELECT id FROM study_chapter_completions WHERE user_id = ? AND chapter_id = ? AND organization_id = ?', [userId, chapterId, orgId]);
  if (rows.length) await query('DELETE FROM study_chapter_completions WHERE user_id = ? AND chapter_id = ? AND organization_id = ?', [userId, chapterId, orgId]);
  else await query('INSERT INTO study_chapter_completions (id, user_id, chapter_id, book_id, organization_id) VALUES (?, ?, ?, ?, ?)', [uuidv4(), userId, chapterId, bookId, orgId]);
  const { rows: completed } = await query('SELECT chapter_id FROM study_chapter_completions WHERE user_id = ? AND book_id = ? AND organization_id = ?', [userId, bookId, orgId]);
  return apiResponse(200, { success: true, chapter_id: chapterId, completed: !rows.length, completed_chapter_ids: completed.map(row => row.chapter_id) });
};

// ============================================================================
// 8. COMPATIBILIDADE LEGADA: GET /studies, POST /studies, DELETE /studies
// ============================================================================
export const createOrUpdateStudy = createOrUpdateStudyBook;
export const getStudies = getStudyBooks;
export const deleteStudy = deleteStudyBook;

