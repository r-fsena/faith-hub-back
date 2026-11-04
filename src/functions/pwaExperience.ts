import { APIGatewayProxyEvent } from "aws-lambda";
import { apiResponse, query } from "../db";
import {
  requireAuth,
  enforceRole,
  enforceTenant,
} from "../services/authMiddleware";
import { checkRateLimit } from "../services/rateLimiter";
import { corsPreflight } from "./corsPreflight";
import {
  publishedExperience,
  editorExperience,
  changeExperience,
  experienceEnabled,
  ExperienceError,
} from "../services/pwaExperienceService";
export async function pwaExperienceHandler(event: APIGatewayProxyEvent) {
  try {
    const method =
      (event as any).requestContext?.http?.method || event.httpMethod;
    if (method === "OPTIONS") return corsPreflight();
    const validId = (value: unknown) =>
      typeof value === "string" && /^[a-z0-9_-]{1,100}$/i.test(value);
    const path = ((event as any).rawPath || event.path || "")
      .split("/")
      .filter(Boolean)
      .pop();
    const rate = await checkRateLimit(event, {
      maxRequests: method === "GET" ? 100 : 30,
      windowSeconds: 60,
      identifierPrefix: "pwa-experience",
    });
    if (!rate.allowed) return rate.errorResponse!;
    if (method === "GET" && path === "published") {
      const org = event.queryStringParameters?.organization_id;
      if (!validId(org))
        return apiResponse(400, { message: "Informe a organização." });
      const campus = event.queryStringParameters?.campus_id || null;
      if (campus && !validId(campus))
        return apiResponse(400, { message: "Unidade inválida." });
      return apiResponse(200, await publishedExperience(org!, campus), {
        "Cache-Control": "no-store",
      });
    }
    const auth = await requireAuth(event);
    if ("errorResponse" in auth) return auth.errorResponse;
    const role = enforceRole(auth.user, ["SUPERADMIN", "PASTOR", "ADMIN"]);
    if (!role.allowed) return role.errorResponse!;
    const body = method === "GET" ? {} : JSON.parse(event.body || "{}");
    const requested = [
      body.organization_id,
      event.queryStringParameters?.organization_id,
      event.headers?.["x-organization-id"],
    ].filter(Boolean);
    if (requested.some((id) => !validId(id)))
      return apiResponse(400, { message: "Organização inválida." });
    if (new Set(requested).size > 1)
      return apiResponse(403, { message: "Organizações conflitantes." });
    const scope = enforceTenant(auth.user, requested[0]);
    if (!scope.allowed) return scope.errorResponse!;
    const org = scope.effectiveOrgId;
    const campus =
      body.campus_id || event.queryStringParameters?.campus_id || null;
    if (campus && !validId(campus))
      return apiResponse(400, { message: "Unidade inválida." });
    if (campus) {
      const { rows } = await query(
        "SELECT id FROM campuses WHERE organization_id = ? AND id = ?",
        [org, campus],
      );
      if (!rows.length)
        return apiResponse(404, { message: "Unidade não encontrada." });
      if (
        !auth.user.isSuperAdmin &&
        !auth.user.campusIds.includes("all") &&
        !auth.user.campusIds.includes(campus)
      )
        return apiResponse(403, { message: "Sem acesso a esta unidade." });
    }
    if (!(await experienceEnabled(org, campus)))
      return apiResponse(403, {
        message: "Editor indisponível nesta organização.",
      });
    if (method === "GET" && path === "editor")
      return apiResponse(200, await editorExperience(org, campus), {
        "Cache-Control": "no-store",
      });
    if (
      method === "POST" &&
      ["draft", "publish", "restore"].includes(path || "")
    )
      return apiResponse(
        200,
        await changeExperience(org, campus, path as any, body, {
          organizationId: org,
          user: auth.user,
          action: "",
          resource: "",
          event,
        }),
      );
    return apiResponse(404, { message: "Ação não encontrada." });
  } catch (e) {
    if (e instanceof ExperienceError)
      return apiResponse(e.status, { message: e.message });
    if (
      e instanceof SyntaxError ||
      String((e as Error).message).startsWith("Configuração inválida:")
    )
      return apiResponse(400, { message: (e as Error).message });
    console.error("PWA experience failed", { name: (e as Error).name });
    return apiResponse(503, {
      message: "Não foi possível concluir. Sua edição local foi preservada.",
    });
  }
}
