import catalog from '../config/commercialPlans.json';

export const COMMERCIAL_CATALOG = catalog;
export const COMMERCIAL_PLAN_IDS = new Set(catalog.plans.map(plan => plan.id));
export const LEGACY_PLAN_IDS = new Set(catalog.legacy_plan_ids);
export const ENTITLEMENT_KEYS = new Set(Object.keys(catalog.plans[0].entitlements));

export interface PlanContract {
  version: string;
  plan_id: string;
  name: string;
  monthly_price: number;
  max_members: number;
  max_campuses: number;
  billing_cycle: string;
  features: string[];
  entitlements: Record<string, boolean>;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value as T;
}

export function normalizeEntitlements(value: unknown): Record<string, boolean> {
  const input = parseJson<any>(value, null);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('PLAN_ENTITLEMENTS_REQUIRED');
  const flags: Record<string, boolean> = {};
  for (const key of ENTITLEMENT_KEYS) {
    // Additive, free evolution of content indicators. Explicit denials and existing commercial terms are preserved.
    const base=input['intelligence.overview']??input['content.analytics_dashboard']===true;
    const additions=['intelligence.activation','intelligence.member_journey','intelligence.actions','intelligence.goals'];
    const value = input[key] === undefined && ['intelligence.overview','intelligence.usage_collection'].includes(key)
      ? input['content.analytics_dashboard'] === true : input[key]===undefined&&additions.includes(key)
      ? !!base&&(key!=='intelligence.member_journey'||input['visitors.module_enabled']===true) : input[key]===undefined&&key==='intelligence.finance'
      ? !!base&&input['financial.cashflow_ledger']===true : input[key]===undefined&&key==='intelligence.operations'
      ? !!base&&['events.module_enabled','pdv.module_enabled','kids.module_enabled','volunteers.module_enabled'].some(k=>input[k]===true) : input[key]===undefined&&key==='intelligence.multicampus'
      ? !!base&&input['system.multicampus_enabled']===true : input[key];
    if (typeof value !== 'boolean') throw new Error(`INVALID_PLAN_ENTITLEMENT:${key}`);
    flags[key] = value;
  }
  if (Object.keys(input).some(key => !ENTITLEMENT_KEYS.has(key))) throw new Error('UNKNOWN_PLAN_ENTITLEMENT');
  for (const [key, enabled] of Object.entries(flags)) {
    const parent = `${key.split('.')[0]}.module_enabled`;
    if (enabled && ENTITLEMENT_KEYS.has(parent) && !flags[parent]) throw new Error(`PLAN_ENTITLEMENT_DEPENDENCY:${key}:${parent}`);
  }
  if (flags['volunteers.module_enabled'] && !flags['ministries.module_enabled']) throw new Error('PLAN_ENTITLEMENT_DEPENDENCY:volunteers:ministries');
  for (const key of ['secretariat.document_pdf', 'secretariat.public_verification', 'secretariat.template_editor']) {
    if (flags[key] && !flags['secretariat.documents']) throw new Error(`PLAN_ENTITLEMENT_DEPENDENCY:${key}:secretariat.documents`);
  }
  flags['system.plan_entitlements'] = true;
  return flags;
}

export function buildPlanContract(plan: any, options: {
  monthly_amount?: unknown; max_members?: unknown; max_campuses?: unknown; billing_cycle?: string;
} = {}): PlanContract {
  if (!plan?.id || plan.status !== 'ACTIVE' || !plan.entitlements) throw new Error('CONTRACTABLE_PLAN_REQUIRED');
  const monthly = options.monthly_amount ?? plan.monthly_price;
  const members = options.max_members ?? plan.max_members;
  const campuses = options.max_campuses ?? plan.max_campuses;
  if (monthly === null || monthly === '' || !Number.isFinite(Number(monthly)) || Number(monthly) <= 0) throw new Error('CONTRACT_PRICE_REQUIRED');
  if (!Number.isInteger(Number(members)) || Number(members) <= 0 || !Number.isInteger(Number(campuses)) || Number(campuses) <= 0) {
    throw new Error('CONTRACT_CAPACITY_REQUIRED');
  }
  const entitlements = normalizeEntitlements(plan.entitlements);
  if (Number(campuses) > 1 && !entitlements['system.multicampus_enabled']) throw new Error('MULTICAMPUS_NOT_INCLUDED');
  if (['CONECTAR', 'CUIDAR', 'GESTAO'].includes(plan.id) && (Number(members) > 1500 || Number(campuses) > 5)) {
    throw new Error('ENTERPRISE_CONTRACT_REQUIRED');
  }
  const cycle = options.billing_cycle || 'MONTHLY';
  if (cycle !== 'MONTHLY' && !Number(plan.yearly_price)) throw new Error('BILLING_CYCLE_NOT_DEFINED');
  return {
    version: catalog.version, plan_id: plan.id, name: plan.name,
    monthly_price: Number(monthly), max_members: Number(members), max_campuses: Number(campuses),
    billing_cycle: cycle, features: parseJson<string[]>(plan.features, []), entitlements
  };
}

export function readPlanContract(value: unknown, planId: string): PlanContract | null {
  const parsed = parseJson<any>(value, null);
  if (!parsed) return null;
  if (parsed.version !== catalog.version || parsed.plan_id !== planId) throw new Error('PLAN_CONTRACT_MISMATCH');
  // Validate the complete snapshot, including capacity and price; null never means unlimited.
  return buildPlanContract({
    id: parsed.plan_id, name: parsed.name, status: 'ACTIVE', features: parsed.features,
    entitlements: parsed.entitlements, monthly_price: parsed.monthly_price,
    max_members: parsed.max_members, max_campuses: parsed.max_campuses,
    yearly_price: parsed.billing_cycle === 'YEARLY' ? parsed.monthly_price : null
  }, { billing_cycle: parsed.billing_cycle });
}

/** Feature switches may disable a contracted resource, but cannot purchase another module. */
export function applyContractEntitlements(flags: Record<string, boolean>, contract: PlanContract): Record<string, boolean> {
  const resolved: Record<string, boolean> = { ...flags };
  for (const key of ENTITLEMENT_KEYS) {
    resolved[key] = contract.entitlements[key] && (flags[key] === undefined || flags[key]);
  }
  // All product namespaces are allowlisted. Unknown future resources require a new contract revision.
  for (const key of Object.keys(resolved)) {
    if (!ENTITLEMENT_KEYS.has(key) && !key.startsWith('system.saas_')) resolved[key] = false;
  }
  return resolved;
}
