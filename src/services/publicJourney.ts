import {memberStatement} from './memberHistoryWrite';
import { randomBytes, createHash } from "crypto";
import { v4 as uuid } from "uuid";
import { query, getConnection } from "../db";
import { buildPlanContract, parseJson } from "./planCatalog";
import { evaluateTenantFlags } from "./featureFlagService";
import { initializePlanEntitlements } from "./planProvisioning";

export const TERMS_VERSION = "2026-11-03";
export const PUBLIC_PLAN_IDS = ["CONECTAR", "CUIDAR", "GESTAO"];
export const offerRevision = (contract: unknown) =>
  createHash("sha256").update(JSON.stringify(contract)).digest("hex");
export const JOURNEY_FLAG = "system.saas_public_journey";
export const CHECKOUT_FLAG = "system.saas_public_checkout";
export class JourneyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface JourneyOwner {
  sub: string;
  email: string;
  name: string;
}
const text = (v: unknown, max = 200) =>
  String(v ?? "")
    .trim()
    .slice(0, max);
export async function journeyCapabilities() {
  const features = await evaluateTenantFlags("org_default", null, "production");
  return {
    enabled: features.flags[JOURNEY_FLAG] === true,
    checkout: features.flags[CHECKOUT_FLAG] === true,
  };
}
export async function publicOffers() {
  const capabilities = await journeyCapabilities();
  const { rows } = await query(
    "SELECT * FROM saas_plans WHERE status = 'ACTIVE' AND id IN ('CONECTAR','CUIDAR','GESTAO','ENTERPRISE_2026') ORDER BY monthly_price IS NULL,monthly_price",
    [],
  );
  return {
    ...capabilities,
    terms_version: TERMS_VERSION,
    trial: {
      plan_id: "CONECTAR",
      days: 14,
      max_members: 300,
      max_campuses: 1,
      assisted: true,
    },
    plans: rows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      monthly_price: p.monthly_price === null ? null : Number(p.monthly_price),
      max_members: p.max_members,
      max_campuses: p.max_campuses,
      features: parseJson(p.features, []),
      requires_proposal: !!Number(p.requires_proposal),
      trial_available: p.id === "CONECTAR",
      offer_revision:
        PUBLIC_PLAN_IDS.includes(p.id) && !Number(p.requires_proposal)
          ? offerRevision(buildPlanContract(p, { billing_cycle: "MONTHLY" }))
          : null,
    })),
  };
}
export async function getAcquisition(owner: JourneyOwner, id?: string) {
  const { rows } = await query(
    `SELECT * FROM saas_acquisitions WHERE owner_sub = ?${id ? " AND id = ?" : ""} LIMIT 1`,
    id ? [owner.sub, id] : [owner.sub],
  );
  if (!rows.length) return null;
  return rows[0];
}
export async function assertOwnerAvailable(
  owner: JourneyOwner,
  targetOrganization?: string | null,
) {
  // Sole pre-tenant identity bootstrap, bound to an already verified Cognito identity.
  const { rows } = await query(
    "SELECT id,organization_id FROM members WHERE id = ? OR LOWER(email) = ? LIMIT 2",
    [owner.sub, owner.email],
  );
  if (rows.some((row) => row.organization_id !== targetOrganization))
    throw new JourneyError(
      409,
      "Este acesso já pertence a uma igreja. Entre no Studio para administrar a assinatura existente ou fale com a equipe.",
    );
}
export async function offerContract(planId: string) {
  if (!PUBLIC_PLAN_IDS.includes(planId))
    throw new JourneyError(
      400,
      "Selecione Conectar, Cuidar ou Gestão. Enterprise exige proposta.",
    );
  const { rows } = await query(
    "SELECT * FROM saas_plans WHERE id = ? AND status = 'ACTIVE'",
    [planId],
  );
  if (!rows[0] || rows[0].requires_proposal)
    throw new JourneyError(
      409,
      "Oferta indisponível para contratação pública.",
    );
  return buildPlanContract(rows[0], { billing_cycle: "MONTHLY" });
}
export async function createAcquisition(owner: JourneyOwner, body: any) {
  if (!(await journeyCapabilities()).enabled)
    throw new JourneyError(503, "A jornada está temporariamente indisponível.");
  if (body.termsAccepted !== true || body.terms_version !== TERMS_VERSION)
    throw new JourneyError(
      400,
      "Leia e aceite as condições atualizadas para continuar.",
    );
  const mode =
    body.mode === "TRIAL" ? "TRIAL" : body.mode === "PAID" ? "PAID" : "";
  const planId = text(body.plan_id, 50).toUpperCase();
  if (!mode)
    throw new JourneyError(400, "Escolha contratação ou teste assistido.");
  if (mode === "TRIAL" && planId !== "CONECTAR")
    throw new JourneyError(
      400,
      "O teste de 14 dias está disponível somente no Conectar.",
    );
  if (
    [
      "monthly_amount",
      "monthly_price",
      "entitlements",
      "organization_id",
      "max_members",
      "max_campuses",
      "discount_type",
    ].some((k) => k in body)
  )
    throw new JourneyError(
      400,
      "Valores, módulos e limites são definidos pelo catálogo.",
    );
  const church = text(body.church_name, 180),
    name = text(body.contact_name, 150),
    document = text(body.document, 30).replace(/\D/g, "");
  if (church.length < 2 || name.length < 2)
    throw new JourneyError(400, "Informe o nome da igreja e do responsável.");
  if (mode === "PAID" && !validDocument(document))
    throw new JourneyError(
      400,
      "Informe um CPF ou CNPJ válido para a cobrança.",
    );
  const existing = await getAcquisition(owner);
  if (existing) return existing;
  await assertOwnerAvailable(owner);
  const contract = await offerContract(planId);
  if (body.offer_revision !== offerRevision(contract))
    throw new JourneyError(
      409,
      "A oferta foi atualizada. Recarregue os planos e confira as condições antes de continuar.",
    );
  const id = uuid();
  const source = Object.fromEntries(
    ["origin", "utm_source", "utm_medium", "utm_campaign", "utm_content"]
      .filter((k) => typeof body.source?.[k] === "string")
      .map((k) => [k, text(body.source[k], 100)]),
  );
  await query(
    `INSERT INTO saas_acquisitions (id,owner_sub,owner_email,contact_name,contact_phone,church_name,document,plan_id,mode,status,plan_contract,source,terms_version,terms_accepted_at)
 VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,UTC_TIMESTAMP())`,
    [
      id,
      owner.sub,
      owner.email,
      name,
      text(body.contact_phone, 40),
      church,
      document || null,
      planId,
      mode,
      mode === "TRIAL" ? "TRIAL_REQUESTED" : "DRAFT",
      JSON.stringify(contract),
      JSON.stringify(source),
      TERMS_VERSION,
    ],
  );
  return (await getAcquisition(owner, id))!;
}
export function validDocument(value: string) {
  if (!/^\d{11}$|^\d{14}$/.test(value) || /^(\d)\1+$/.test(value)) return false;
  const digit = (s: string, weights: number[]) => {
    const sum = weights.reduce((n, w, i) => n + Number(s[i]) * w, 0);
    return sum % 11 < 2 ? 0 : 11 - (sum % 11);
  };
  if (value.length === 11) {
    for (let len = 9; len <= 10; len++) {
      let n = 0;
      for (let i = 0; i < len; i++) n += Number(value[i]) * (len + 1 - i);
      const d = (n * 10) % 11;
      if (Number(value[len]) !== (d === 10 ? 0 : d)) return false;
    }
    return true;
  }
  return (
    digit(value, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(value[12]) &&
    digit(value, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(value[13])
  );
}
export async function createPublicProposal(
  owner: JourneyOwner,
  id: string,
  body: any = {},
) {
  const capabilities = await journeyCapabilities();
  if (!capabilities.enabled || !capabilities.checkout)
    throw new JourneyError(
      503,
      "Contratação online indisponível neste momento. Sua solicitação foi preservada.",
    );
  const db = await getConnection();
  try {
    await db.beginTransaction();
    const [records] = (await db.query(
      "SELECT * FROM saas_acquisitions WHERE id = ? AND owner_sub = ? FOR UPDATE",
      [id, owner.sub],
    )) as any;
    const row = records[0];
    if (!row) throw new JourneyError(404, "Solicitação não encontrada.");
    if (row.proposal_id) {
      await db.commit();
      const { rows } = await query(
        "SELECT token FROM saas_proposals WHERE id = ?",
        [row.proposal_id],
      );
      return { token: rows[0].token };
    }
    if (row.mode === "TRIAL" && !row.organization_id)
      throw new JourneyError(
        409,
        "O teste precisa estar aprovado antes da conversão.",
      );
    if (
      row.mode === "TRIAL" &&
      (body.termsAccepted !== true || body.terms_version !== TERMS_VERSION)
    )
      throw new JourneyError(
        400,
        "Aceite as condições da assinatura para converter o teste.",
      );
    if (
      [
        "monthly_amount",
        "monthly_price",
        "entitlements",
        "organization_id",
        "discount_type",
        "max_members",
        "max_campuses",
      ].some((k) => k in body)
    )
      throw new JourneyError(400, "A oferta é definida pelo catálogo.");
    const document = text(body.document || row.document, 30).replace(/\D/g, "");
    if (!validDocument(document))
      throw new JourneyError(400, "Informe CPF/CNPJ válido para continuar.");
    await assertOwnerAvailable(owner, row.organization_id);
    const contract =
      row.mode === "TRIAL"
        ? await offerContract(text(body.plan_id, 50).toUpperCase())
        : parseJson<any>(row.plan_contract, null);
    if (row.mode === "TRIAL" && body.offer_revision !== offerRevision(contract))
      throw new JourneyError(
        409,
        "A oferta foi atualizada. Recarregue e confira o valor antes de contratar.",
      );
    if (!contract || !PUBLIC_PLAN_IDS.includes(contract.plan_id))
      throw new JourneyError(409, "Oferta inválida.");
    const proposalId = uuid(),
      token = randomBytes(24).toString("hex");
    await db.query(
      `INSERT INTO saas_proposals (id,token,church_name,cnpj_cpf,contact_name,contact_email,contact_phone,plan_tier,billing_cycle,monthly_amount,setup_fee,status,features_included,expires_at,created_by,discount_type,discount_value,first_cycle_amount,plan_contract)
 VALUES (?,?,?,?,?,?,?,?, 'MONTHLY',?,0,'SENT',?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 7 DAY),'Public journey','NONE',0,?,?)`,
      [
        proposalId,
        token,
        row.church_name,
        document,
        row.contact_name,
        row.owner_email,
        row.contact_phone,
        contract.plan_id,
        contract.monthly_price,
        JSON.stringify(contract.features),
        contract.monthly_price,
        JSON.stringify(contract),
      ],
    );
    await db.query(
      `UPDATE saas_acquisitions SET proposal_id = ?,document = ?,plan_id = ?,plan_contract = ?,status='CHECKOUT_PENDING' WHERE id = ? AND owner_sub = ?`,
      [
        proposalId,
        document,
        contract.plan_id,
        JSON.stringify(contract),
        id,
        owner.sub,
      ],
    );
    await db.query(
      `INSERT INTO security_audit_logs (id,organization_id,user_id,user_email,user_role,action,resource,resource_id,details,status) VALUES (?, ?, ?, ?, 'OWNER','PUBLIC_SUBSCRIPTION_REQUEST','saas_proposals',?,?,'SUCCESS')`,
      [
        uuid(),
        row.organization_id || "org_default",
        owner.sub,
        owner.email,
        proposalId,
        JSON.stringify({
          plan: contract.plan_id,
          amount: contract.monthly_price,
          terms_version: TERMS_VERSION,
        }),
      ],
    );
    await db.commit();
    return { token };
  } catch (e) {
    await db.rollback();
    throw e;
  } finally {
    db.release();
  }
}
export async function approveTrial(id: string, executorEmail: string) {
  const db = await getConnection();
  try {
    await db.beginTransaction();
    const [records] = (await db.query(
      "SELECT * FROM saas_acquisitions WHERE id = ? FOR UPDATE",
      [id],
    )) as any;
    const row = records[0];
    if (!row) throw new JourneyError(404, "Solicitação não encontrada.");
    if (row.mode !== "TRIAL" || row.plan_id !== "CONECTAR")
      throw new JourneyError(409, "Somente Conectar é elegível ao teste.");
    if (row.organization_id) {
      await db.commit();
      return { organization_id: row.organization_id };
    }
    if (row.status !== "TRIAL_REQUESTED")
      throw new JourneyError(409, "Solicitação fora da etapa de aprovação.");
    await assertOwnerAvailable({
      sub: row.owner_sub,
      email: row.owner_email,
      name: row.contact_name,
    });
    const contract = parseJson<any>(row.plan_contract, null);
    if (contract?.plan_id !== "CONECTAR")
      throw new JourneyError(409, "Contrato de teste inválido.");
    const digest = createHash("sha256").update(id).digest("hex").slice(0, 16),
      org = `org_${digest}`,
      campus = `campus_${digest}`,
      slug = `igreja-${digest}`;
    await db.query(
      `INSERT INTO organizations (id,name,slug,cnpj,plan,status,primary_color,secondary_color) VALUES (?,?,?,?,'CONECTAR','ACTIVE','#0f766e','#14b8a6')`,
      [org, row.church_name, slug, row.document],
    );
    await db.query(
      "UPDATE organizations SET trial_pending_start = 1 WHERE id = ?",
      [org],
    );
    await db.query(
      `INSERT INTO campuses (id,organization_id,name,slug,is_headquarters,status) VALUES (?,?,?,'sede',1,'ACTIVE')`,
      [campus, org, `${row.church_name} - Sede`],
    );
    await db.query(
      `INSERT INTO church_settings (id,church_name,primary_color,secondary_color,pwa_theme_color,pwa_short_name,pwa_slug,organization_id,campus_id,offline_mode) VALUES (?,?, '#0f766e','#14b8a6','#0f766e',?,?,?,?,0)`,
      [
        `settings_${digest}`,
        row.church_name,
        row.church_name.slice(0, 12),
        slug,
        org,
        campus,
      ],
    );
    await memberStatement(db,`INSERT INTO members (id,name,email,role,status,organization_id,campus_id,campus_ids) VALUES (?,?,?,'ADMIN','ACTIVE',?,?,'["all"]')`, [row.owner_sub, row.contact_name, row.owner_email, org, campus], {organizationId:org,source:'PUBLIC_JOURNEY'});
    await initializePlanEntitlements(org, contract, (sql, params) =>
      db.query(sql, params),
    );
    await db.query(
      `UPDATE saas_acquisitions SET organization_id = ?,status='TRIAL_READY',trial_approved_at=UTC_TIMESTAMP(),last_error=NULL WHERE id = ?`,
      [org, id],
    );
    await db.query(
      `INSERT INTO security_audit_logs (id,organization_id,user_email,user_role,action,resource,resource_id,details,status) VALUES (?,?,?,'SUPERADMIN','APPROVE_CONNECT_TRIAL','organizations',?,?,'SUCCESS')`,
      [
        uuid(),
        org,
        executorEmail,
        org,
        JSON.stringify({
          acquisition: id,
          days: 14,
          startsOnOwnerConfirmation: true,
        }),
      ],
    );
    await db.commit();
    return { organization_id: org };
  } catch (e) {
    await db.rollback();
    throw e;
  } finally {
    db.release();
  }
}

export async function startTrial(
  owner: JourneyOwner,
  id: string,
  organizationId: string,
) {
  const db = await getConnection();
  try {
    await db.beginTransaction();
    const [records] = (await db.query(
      "SELECT * FROM saas_acquisitions WHERE id = ? AND owner_sub = ? AND organization_id = ? FOR UPDATE",
      [id, owner.sub, organizationId],
    )) as any;
    const row = records[0];
    if (
      !row ||
      row.mode !== "TRIAL" ||
      row.plan_id !== "CONECTAR" ||
      !["TRIAL_READY", "TRIAL_ACTIVE", "CHECKOUT_PENDING"].includes(row.status)
    )
      throw new JourneyError(409, "O teste precisa estar aprovado e pronto.");
    if (!row.trial_started_at) {
      await db.query(
        `UPDATE saas_acquisitions SET status=IF(status='TRIAL_READY','TRIAL_ACTIVE',status),trial_started_at=UTC_TIMESTAMP(),trial_expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 14 DAY) WHERE id = ? AND owner_sub = ? AND organization_id = ?`,
        [id, owner.sub, organizationId],
      );
      await db.query(
        `UPDATE organizations o JOIN saas_acquisitions a ON a.organization_id=o.id SET o.trial_started_at=a.trial_started_at,o.trial_expires_at=a.trial_expires_at,o.trial_pending_start=0 WHERE o.id = ? AND a.id = ? AND a.owner_sub = ? AND o.plan = 'CONECTAR'`,
        [organizationId, id, owner.sub],
      );
    }
    await db.commit();
    return (await getAcquisition(owner, id))!;
  } catch (e) {
    await db.rollback();
    throw e;
  } finally {
    db.release();
  }
}
