import { query, getConnection } from "../db";
import { v4 as uuid } from "uuid";
import { evaluateTenantFlags } from "./featureFlagService";
import { logSecurityEvent, AuditLogEntry } from "./auditLogService";
import {
  EXPERIENCE_FLAG,
  validatePatch,
  resolveExperience,
  merge,
  contrastIssues,
} from "../config/pwaExperience";
export class ExperienceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const scopeKey = (campus: string | null) =>
  campus ? `campus:${campus}` : "organization";
const decode = (value: any) =>
  typeof value === "string" ? JSON.parse(value) : value;
export async function experienceEnabled(org: string, campus: string | null) {
  return (
    (await evaluateTenantFlags(org, campus, "production")).flags[
      EXPERIENCE_FLAG
    ] === true
  );
}
export async function experienceBase(org: string) {
  const { rows } = await query(
    "SELECT church_name,slogan,primary_color,secondary_color,logo_icon_url,banner_url,theme_mode FROM church_settings WHERE organization_id = ? ORDER BY updated_at DESC LIMIT 1",
    [org],
  );
  return rows[0] || {};
}
export async function publishedExperience(
  org: string,
  campus: string | null,
  branding?: any,
) {
  // Public configuration contains only overrides; legacy images remain in church-settings once.
  if (!(await experienceEnabled(org, campus)))
    return { enabled: false, config: null, revision: "0" };
  if (campus) {
    const { rows } = await query(
      "SELECT id FROM campuses WHERE organization_id = ? AND id = ?",
      [org, campus],
    );
    if (!rows.length) throw new ExperienceError(404, "Unidade não encontrada.");
  }
  const { rows } = await query(
    "SELECT scope_key,published_json,published_revision FROM pwa_experience_scopes WHERE organization_id = ? AND environment = 'production' AND scope_key IN (?,?)",
    [org, "organization", scopeKey(campus)],
  );
  const organization = rows.find((r) => r.scope_key === "organization"),
    local = campus ? rows.find((r) => r.scope_key === scopeKey(campus)) : null;
  const patch = merge(
    validatePatch(decode(organization?.published_json) || {}),
    validatePatch(decode(local?.published_json) || {}),
  );
  const meaningful = (value: any): boolean =>
    value && typeof value === "object"
      ? Object.entries(value).some(
          ([key, v]) => key !== "schema_version" && meaningful(v),
        )
      : true;
  return {
    enabled: true,
    config: patch,
    revision: `${organization?.published_revision || 0}:${local?.published_revision || 0}`,
    customized: meaningful(patch),
  };
}
export async function editorExperience(org: string, campus: string | null) {
  const base = await experienceBase(org);
  const { rows } = await query(
    "SELECT * FROM pwa_experience_scopes WHERE organization_id = ? AND environment = 'production' AND scope_key IN (?,?)",
    [org, "organization", scopeKey(campus)],
  );
  const own = rows.find((r) => r.scope_key === scopeKey(campus)),
    parent = campus ? rows.find((r) => r.scope_key === "organization") : null;
  const inherited = resolveExperience(base, decode(parent?.published_json));
  const { rows: history } = await query(
    "SELECT id,revision,created_at,created_by FROM pwa_experience_versions WHERE organization_id = ? AND environment = 'production' AND scope_key = ? ORDER BY revision DESC LIMIT 30",
    [org, scopeKey(campus)],
  );
  return {
    revision: Number(own?.revision || 0),
    published_revision: Number(own?.published_revision || 0),
    draft: decode(own?.draft_json) || {},
    published: decode(own?.published_json) || {},
    inherited,
    history,
  };
}
export async function changeExperience(
  org: string,
  campus: string | null,
  action: "draft" | "publish" | "restore",
  body: any,
  audit: AuditLogEntry,
) {
  if (!Number.isInteger(body.expected_revision) || body.expected_revision < 0)
    throw new ExperienceError(400, "Revisão inválida. Atualize o editor.");
  const candidate = action === "draft" ? validatePatch(body.config) : null;
  const db = await getConnection();
  try {
    await db.beginTransaction();
    // Organization lock also serializes creation of the first scope row.
    const [orgRows] = (await db.query(
      "SELECT id FROM organizations WHERE id = ? FOR UPDATE",
      [org],
    )) as any;
    if (!orgRows.length)
      throw new ExperienceError(404, "Organização não encontrada.");
    const [records] = (await db.query(
      "SELECT * FROM pwa_experience_scopes WHERE organization_id = ? AND environment = 'production' AND scope_key = ? FOR UPDATE",
      [org, scopeKey(campus)],
    )) as any;
    const row = records[0];
    if (Number(row?.revision || 0) !== body.expected_revision)
      throw new ExperienceError(
        409,
        "Outra pessoa alterou esta configuração. Seu rascunho foi preservado. Atualize antes de salvar.",
      );
    let next = candidate;
    if (action === "restore") {
      const [versions] = (await db.query(
        "SELECT config_json FROM pwa_experience_versions WHERE organization_id = ? AND environment = 'production' AND scope_key = ? AND id = ?",
        [org, scopeKey(campus), String(body.version_id || "")],
      )) as any;
      if (!versions.length)
        throw new ExperienceError(404, "Versão não encontrada neste escopo.");
      next = validatePatch(decode(versions[0].config_json));
    }
    if (action === "publish") {
      if (row?.draft_json === null || !row)
        throw new ExperienceError(409, "Salve um rascunho antes de publicar.");
      next = validatePatch(decode(row.draft_json));
      const [settings] = (await db.query(
        "SELECT church_name,slogan,primary_color,secondary_color,theme_mode FROM church_settings WHERE organization_id = ? ORDER BY updated_at DESC LIMIT 1",
        [org],
      )) as any;
      let parent = null;
      if (campus) {
        const [parents] = (await db.query(
          "SELECT published_json FROM pwa_experience_scopes WHERE organization_id = ? AND environment = 'production' AND scope_key = 'organization' FOR UPDATE",
          [org],
        )) as any;
        parent = decode(parents[0]?.published_json);
      }
      const issues = contrastIssues(
        resolveExperience(settings[0] || {}, parent, next),
      );
      if (issues.length)
        throw new ExperienceError(
          422,
          `Revise o contraste: ${issues.slice(0, 4).join("; ")}`,
        );
      if (!campus) {
        const [children] = (await db.query(
          "SELECT scope_key,published_json FROM pwa_experience_scopes WHERE organization_id = ? AND environment = 'production' AND campus_id IS NOT NULL AND published_json IS NOT NULL FOR UPDATE",
          [org],
        )) as any;
        for (const child of children) {
          const problems = contrastIssues(
            resolveExperience(
              settings[0] || {},
              next,
              decode(child.published_json),
            ),
          );
          if (problems.length)
            throw new ExperienceError(
              422,
              `A nova identidade prejudica o contraste da unidade ${child.scope_key}. Revise os ajustes da unidade antes de publicar.`,
            );
        }
      }
    }
    const revision = body.expected_revision + 1;
    if (!row)
      await db.query(
        "INSERT INTO pwa_experience_scopes (organization_id,environment,scope_key,campus_id,revision,draft_json) VALUES (?,'production',?,?,?,?)",
        [org, scopeKey(campus), campus, revision, JSON.stringify(next)],
      );
    else if (action === "publish")
      await db.query(
        "UPDATE pwa_experience_scopes SET published_json = ?,published_revision = ?,revision = ?,updated_by = ? WHERE organization_id = ? AND environment = 'production' AND scope_key = ?",
        [
          JSON.stringify(next),
          revision,
          revision,
          audit.user?.userId || null,
          org,
          scopeKey(campus),
        ],
      );
    else
      await db.query(
        "UPDATE pwa_experience_scopes SET draft_json = ?,revision = ?,updated_by = ? WHERE organization_id = ? AND environment = 'production' AND scope_key = ?",
        [
          JSON.stringify(next),
          revision,
          audit.user?.userId || null,
          org,
          scopeKey(campus),
        ],
      );
    if (action === "publish")
      await db.query(
        "INSERT INTO pwa_experience_versions (id,organization_id,environment,scope_key,campus_id,revision,config_json,created_by) VALUES (?,?,'production',?,?,?,?,?)",
        [
          uuid(),
          org,
          scopeKey(campus),
          campus,
          revision,
          JSON.stringify(next),
          audit.user?.email || "system",
        ],
      );
    await logSecurityEvent({
      ...audit,
      organizationId: org,
      campusId: campus,
      action: `PWA_EXPERIENCE_${action.toUpperCase()}`,
      resource: "pwa_experience_scopes",
      resourceId: scopeKey(campus),
      details: {
        revision,
        version_id: action === "restore" ? body.version_id : undefined,
      },
      executor: (sql, params) => db.query(sql, params),
      strict: true,
    });
    await db.commit();
    return {
      revision,
      published_revision:
        action === "publish" ? revision : Number(row?.published_revision || 0),
    };
  } catch (e) {
    await db.rollback();
    throw e;
  } finally {
    db.release();
  }
}
