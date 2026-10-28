import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { apiResponse, query } from '../db';
import { AuthUser, enforceRole, enforceTenant, requireAuth } from '../services/authMiddleware';
import { evaluateTenantFlags, ResolvedFeatureFlags } from '../services/featureFlagService';

const STUDIO_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'TREASURER', 'LEADER', 'VOLUNTEER'];
const SEARCH_ROLES = ['SUPERADMIN', 'PASTOR', 'ADMIN', 'LEADER'];
const ONBOARDING_STEPS = new Set(['organization', 'campus', 'branding', 'members', 'team', 'modules', 'first_module']);
const NAVIGATION_TABS = new Set([
  'dashboard', 'people_workspace', 'membros', 'visitantes', 'pastoral_radar', 'celulas',
  'ministries_workspace', 'ministerios', 'kids_workspace', 'kids_salas', 'kids_checkin',
  'kids_chamados', 'kids_familias', 'kids_config_salas', 'kids_relatorios',
  'secretariat_workspace', 'secretariat_overview', 'secretariat_records', 'secretariat_movements',
  'secretariat_documents', 'secretariat_baptisms', 'secretariat_templates',
  'content_workspace', 'eventos', 'transmissoes', 'devocionais', 'estudos', 'bible_config', 'oracoes',
  'operations_workspace', 'pdv_produtos', 'pdv_pedidos',
  'finance_workspace', 'financial_treasury', 'financial_projects', 'pagarme_financeiro',
  'administration_workspace', 'campuses', 'church_branding', 'feature_flags', 'security_audit',
  'my_subscription', 'configuracoes'
]);

interface StudioScope {
  user: AuthUser;
  organizationId: string;
  campusId: string | null;
  features: ResolvedFeatureFlags;
}

function parseJson(value: any, fallback: any): any {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function bodyOf(event: APIGatewayProxyEvent): any {
  try { return JSON.parse(event.body || '{}'); } catch { return {}; }
}

function safeTabs(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter(tab => NAVIGATION_TABS.has(tab)))].slice(0, max);
}

function safeRecent(value: unknown): Array<{ tab: string; at: string }> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: Array<{ tab: string; at: string }> = [];
  for (const item of value) {
    const tab = String(item?.tab || '');
    if (!NAVIGATION_TABS.has(tab) || seen.has(tab)) continue;
    seen.add(tab);
    const parsed = new Date(item?.at || Date.now());
    result.push({ tab, at: Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString() });
    if (result.length >= 8) break;
  }
  return result;
}

async function authorizeStudio(event: APIGatewayProxyEvent, allowedRoles = STUDIO_ROLES): Promise<StudioScope | APIGatewayProxyResult> {
  const auth = await requireAuth(event);
  if ('errorResponse' in auth) return auth.errorResponse;
  const role = enforceRole(auth.user, allowedRoles);
  if (!role.allowed) return role.errorResponse!;
  const body = bodyOf(event);
  const requestedOrg = event.queryStringParameters?.organization_id || event.headers?.['x-organization-id'] || body.organization_id;
  const tenant = enforceTenant(auth.user, requestedOrg);
  if (!tenant.allowed) return tenant.errorResponse!;
  const requestedCampus = event.queryStringParameters?.campus_id || event.headers?.['x-campus-id'] || body.campus_id;
  const campusId = requestedCampus && requestedCampus !== 'all' ? requestedCampus : null;
  const features = await evaluateTenantFlags(tenant.effectiveOrgId, campusId, 'production');
  return { user: auth.user, organizationId: tenant.effectiveOrgId, campusId, features };
}

function isResponse(value: StudioScope | APIGatewayProxyResult): value is APIGatewayProxyResult {
  return 'statusCode' in value;
}

export const getPreferences = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const scope = await authorizeStudio(event);
    if (isResponse(scope)) return scope;
    if (!scope.features.flags['studio.guided_onboarding'] && !scope.features.flags['studio.personalized_navigation']) {
      return apiResponse(403, { error: 'FEATURE_DISABLED', message: 'A experiência personalizada do Studio não está habilitada.' });
    }
    const result = await query(`SELECT onboarding_steps, onboarding_dismissed, favorite_tabs, recent_tabs, updated_at
      FROM studio_user_preferences WHERE organization_id = ? AND user_id = ? LIMIT 1`,
    [scope.organizationId, scope.user.userId]);
    const row = result.rows[0] || {};
    return apiResponse(200, { data: {
      onboarding_steps: parseJson(row.onboarding_steps, []),
      onboarding_dismissed: Boolean(Number(row.onboarding_dismissed || 0)),
      favorite_tabs: parseJson(row.favorite_tabs, []),
      recent_tabs: parseJson(row.recent_tabs, []),
      updated_at: row.updated_at || null
    } });
  } catch (error) {
    console.error('Erro ao carregar preferências do Studio:', error);
    return apiResponse(500, { error: 'Não foi possível carregar as preferências do Studio.' });
  }
};

export const updatePreferences = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const scope = await authorizeStudio(event);
    if (isResponse(scope)) return scope;
    const body = bodyOf(event);
    const changesOnboarding = body.onboarding_steps !== undefined || body.onboarding_dismissed !== undefined;
    const changesNavigation = body.favorite_tabs !== undefined || body.recent_tabs !== undefined;
    if (changesOnboarding && !scope.features.flags['studio.guided_onboarding']) {
      return apiResponse(403, { error: 'FEATURE_DISABLED', message: 'O onboarding guiado não está habilitado.' });
    }
    if (changesNavigation && !scope.features.flags['studio.personalized_navigation']) {
      return apiResponse(403, { error: 'FEATURE_DISABLED', message: 'A navegação personalizada não está habilitada.' });
    }
    const currentResult = await query(`SELECT onboarding_steps, onboarding_dismissed, favorite_tabs, recent_tabs
      FROM studio_user_preferences WHERE organization_id = ? AND user_id = ? LIMIT 1`,
    [scope.organizationId, scope.user.userId]);
    const current = currentResult.rows[0] || {};
    const requestedSteps: string[] = (Array.isArray(body.onboarding_steps) ? body.onboarding_steps : []).map((step: unknown) => String(step));
    const onboardingSteps = body.onboarding_steps === undefined
      ? parseJson(current.onboarding_steps, [])
      : [...new Set(requestedSteps.filter((step: string) => ONBOARDING_STEPS.has(step)))];
    const onboardingDismissed = body.onboarding_dismissed === undefined
      ? Boolean(Number(current.onboarding_dismissed || 0)) : Boolean(body.onboarding_dismissed);
    const favoriteTabs = body.favorite_tabs === undefined ? safeTabs(parseJson(current.favorite_tabs, []), 8) : safeTabs(body.favorite_tabs, 8);
    const recentTabs = body.recent_tabs === undefined ? safeRecent(parseJson(current.recent_tabs, [])) : safeRecent(body.recent_tabs);
    await query(`INSERT INTO studio_user_preferences
      (id, organization_id, user_id, onboarding_steps, onboarding_dismissed, favorite_tabs, recent_tabs)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE onboarding_steps = VALUES(onboarding_steps), onboarding_dismissed = VALUES(onboarding_dismissed),
        favorite_tabs = VALUES(favorite_tabs), recent_tabs = VALUES(recent_tabs), updated_at = NOW()`, [
      uuidv4(), scope.organizationId, scope.user.userId, JSON.stringify(onboardingSteps), onboardingDismissed ? 1 : 0,
      JSON.stringify(favoriteTabs), JSON.stringify(recentTabs)
    ]);
    return apiResponse(200, { message: 'Preferências atualizadas.', data: {
      onboarding_steps: onboardingSteps,
      onboarding_dismissed: onboardingDismissed,
      favorite_tabs: favoriteTabs,
      recent_tabs: recentTabs
    } });
  } catch (error) {
    console.error('Erro ao atualizar preferências do Studio:', error);
    return apiResponse(500, { error: 'Não foi possível atualizar as preferências do Studio.' });
  }
};

export const globalSearch = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const scope = await authorizeStudio(event, SEARCH_ROLES);
    if (isResponse(scope)) return scope;
    if (!scope.features.flags['studio.global_search']) {
      return apiResponse(403, { error: 'FEATURE_DISABLED', message: 'A busca global não está habilitada.' });
    }
    const term = String(event.queryStringParameters?.q || '').normalize('NFC').trim().slice(0, 80)
      .replace(/[^\p{L}\p{N}@._\- ]/gu, '');
    if (term.length < 2) return apiResponse(200, { data: [] });
    const like = `%${term}%`;
    const memberCampus = scope.campusId
      ? ' AND (m.campus_id = ? OR JSON_CONTAINS(m.campus_ids, JSON_QUOTE(?)) OR JSON_CONTAINS(m.campus_ids, \'"all"\'))'
      : '';
    const members = await query(`SELECT m.id, m.name, m.role, c.name AS campus_name
      FROM members m
      LEFT JOIN campuses c ON c.organization_id = m.organization_id AND c.id = m.campus_id
      WHERE m.organization_id = ? AND (m.name LIKE ? OR m.email LIKE ?)${memberCampus}
      ORDER BY CASE WHEN m.name LIKE ? THEN 0 ELSE 1 END, m.name ASC LIMIT 8`, [
      scope.organizationId, like, like, ...(scope.campusId ? [scope.campusId, scope.campusId] : []), `${term}%`
    ]);
    const results: any[] = members.rows.map((member: any) => ({
      kind: 'member', id: member.id, title: member.name,
      subtitle: `${member.role || 'MEMBER'}${member.campus_name ? ` · ${member.campus_name}` : ''}`,
      tab: 'membros'
    }));

    const role = String(scope.user.role || '').toUpperCase();
    const permissions = Array.isArray(scope.user.operationalPermissions) ? scope.user.operationalPermissions : [];
    const canSearchDocuments = scope.features.flags['secretariat.documents'] && (
      ['SUPERADMIN', 'PASTOR', 'ADMIN'].includes(role)
      || permissions.includes('secretariat.view')
      || permissions.includes('secretariat.*')
    );
    if (canSearchDocuments) {
      const documentCampus = scope.campusId ? ' AND d.campus_id = ?' : '';
      const documents = await query(`SELECT d.id, d.document_number, d.document_type, d.status, m.name AS member_name
        FROM issued_documents d
        LEFT JOIN members m ON m.organization_id = d.organization_id AND m.id = d.member_id
        WHERE d.organization_id = ? AND (d.document_number LIKE ? OR m.name LIKE ?)${documentCampus}
        ORDER BY d.issued_at DESC LIMIT 6`, [scope.organizationId, like, like, ...(scope.campusId ? [scope.campusId] : [])]);
      results.push(...documents.rows.map((document: any) => ({
        kind: 'document', id: document.id, title: document.document_number,
        subtitle: `${document.member_name || 'Documento eclesiástico'} · ${document.status}`,
        tab: 'secretariat_documents'
      })));
    }
    return apiResponse(200, { data: results.slice(0, 14) });
  } catch (error) {
    console.error('Erro na busca global do Studio:', error);
    return apiResponse(500, { error: 'Não foi possível concluir a busca global.' });
  }
};
