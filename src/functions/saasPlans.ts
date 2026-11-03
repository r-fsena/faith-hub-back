// Commercial descriptions and executable module entitlements belong to the same plan.
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';
import { LEGACY_PLAN_IDS, normalizeEntitlements, parseJson } from '../services/planCatalog';

export const listPlans = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const includeLegacy = event.queryStringParameters?.include_legacy === 'true';
    if (includeLegacy) {
      const auth = await requireAuth(event);
      if ('errorResponse' in auth) return auth.errorResponse;
      const role = enforceRole(auth.user, ['SUPERADMIN']);
      if (!role.allowed) return role.errorResponse!;
      const tenant = enforceTenant(auth.user, event.queryStringParameters?.organization_id);
      if (!tenant.allowed) return tenant.errorResponse!;
    }
    const { rows } = await query('SELECT * FROM saas_plans ORDER BY monthly_price IS NULL, monthly_price ASC');
    const plans = rows.filter(plan => includeLegacy || (plan.status === 'ACTIVE' && plan.entitlements)).map(plan => ({
      ...plan, features: parseJson<string[]>(plan.features, []),
      entitlements: parseJson<Record<string, boolean> | null>(plan.entitlements, null),
      monthly_price: plan.monthly_price === null ? null : Number(plan.monthly_price),
      yearly_price: plan.yearly_price === null ? null : Number(plan.yearly_price),
      is_popular: Boolean(Number(plan.is_popular)), requires_proposal: Boolean(Number(plan.requires_proposal))
    }));
    return apiResponse(200, plans);
  } catch (error: any) {
    console.error('Erro ao listar planos:', error);
    return apiResponse(500, { message: 'Erro ao buscar planos SaaS' });
  }
};

export const createOrUpdatePlan = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;
    const role = enforceRole(auth.user, ['SUPERADMIN']);
    if (!role.allowed) return role.errorResponse!;
    const tenant = enforceTenant(auth.user, event.headers?.['x-organization-id']);
    if (!tenant.allowed) return tenant.errorResponse!;
    const body = JSON.parse(event.body || '{}');
    const planId = String(body.id || body.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!planId || planId.length > 50 || !String(body.name || '').trim()) return apiResponse(400, { message: 'Identificador e nome são obrigatórios.' });
    if (LEGACY_PLAN_IDS.has(planId)) return apiResponse(409, { message: 'Plano legado preservado. Crie uma nova versão para novas contratações.' });
    const entitlements = normalizeEntitlements(body.entitlements);
    const requiresProposal = body.requires_proposal === true;
    const nullable = (value: unknown) => value === null || value === '' || value === undefined ? null : Number(value);
    const monthly = nullable(body.monthly_price);
    const yearly = nullable(body.yearly_price);
    const members = nullable(body.max_members);
    const campuses = nullable(body.max_campuses);
    if ((!requiresProposal && (monthly === null || members === null || campuses === null)) ||
      [monthly, yearly].some(value => value !== null && (!Number.isFinite(value) || value <= 0)) ||
      [members, campuses].some(value => value !== null && (!Number.isInteger(value) || value <= 0))) {
      return apiResponse(400, { message: 'Informe preço e capacidades positivos, ou use sob proposta com valores em aberto.' });
    }
    if (campuses !== null && campuses > 1 && !entitlements['system.multicampus_enabled']) return apiResponse(400, { message: 'Várias unidades exigem o recurso multi-campus no plano.' });
    const features = Array.isArray(body.features) ? body.features.filter((item: any) => typeof item === 'string') : [];
    await query(`INSERT INTO saas_plans
      (id, name, description, monthly_price, yearly_price, badge_text, is_popular, max_members,
       max_campuses, features, status, entitlements, requires_proposal, catalog_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), monthly_price = VALUES(monthly_price),
      yearly_price = VALUES(yearly_price), badge_text = VALUES(badge_text), is_popular = VALUES(is_popular),
      max_members = VALUES(max_members), max_campuses = VALUES(max_campuses), features = VALUES(features),
      status = VALUES(status), entitlements = VALUES(entitlements), requires_proposal = VALUES(requires_proposal), updated_at = NOW()`, [
      planId, body.name.trim(), body.description || '', monthly, yearly, body.badge_text || null,
      Boolean(body.is_popular), members, campuses, JSON.stringify(features), body.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
      JSON.stringify(entitlements), requiresProposal, '2026-11-02'
    ]);
    await logSecurityEvent({ organizationId: tenant.effectiveOrgId, user: auth.user, action: 'UPSERT_SAAS_PLAN',
      resource: 'saas_plans', resourceId: planId, details: { planId, monthly_price: monthly, entitlements, existingContractsChanged: false }, event });
    return apiResponse(200, { message: 'Plano salvo. Contratos existentes foram preservados.', plan: { id: planId } });
  } catch (error: any) {
    if (/PLAN_ENTITLEMENT|PLAN_ENTITLEMENTS/.test(error.message) || error instanceof SyntaxError) return apiResponse(400, { message: error.message });
    console.error('Erro ao salvar plano:', error);
    return apiResponse(500, { message: 'Erro ao salvar plano SaaS' });
  }
};

export const deletePlan = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const auth = await requireAuth(event);
  if ('errorResponse' in auth) return auth.errorResponse;
  const role = enforceRole(auth.user, ['SUPERADMIN']);
  if (!role.allowed) return role.errorResponse!;
  const tenant = enforceTenant(auth.user, event.headers?.['x-organization-id']);
  if (!tenant.allowed) return tenant.errorResponse!;
  const id = event.pathParameters?.id;
  if (!id || LEGACY_PLAN_IDS.has(id)) return apiResponse(409, { message: 'Planos legados devem ser preservados.' });
  // Archiving keeps subscription and proposal references intact.
  await query("UPDATE saas_plans SET status = 'INACTIVE' WHERE id = ?", [id]);
  await logSecurityEvent({ organizationId: tenant.effectiveOrgId, user: auth.user, action: 'ARCHIVE_SAAS_PLAN', resource: 'saas_plans', resourceId: id, event });
  return apiResponse(200, { message: 'Plano arquivado para novas contratações; contratos existentes preservados.' });
};
