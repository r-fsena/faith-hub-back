import { APIGatewayProxyEvent } from "aws-lambda";
import { apiResponse, query } from "../db";
import { getVerifiedClaims } from "../services/tokenVerifier";
import {
  requireAuth,
  enforceRole,
  enforceTenant,
} from "../services/authMiddleware";
import { checkRateLimit } from "../services/rateLimiter";
import { logSecurityEvent } from "../services/auditLogService";
import { parseJson } from "../services/planCatalog";
import { acceptProposal } from "./proposals";
import { corsPreflight } from "./corsPreflight";
import {
  startTrial,
  approveTrial,
  createAcquisition,
  createPublicProposal,
  getAcquisition,
  JourneyError,
  JourneyOwner,
  publicOffers,
} from "../services/publicJourney";

async function ownerOf(event: APIGatewayProxyEvent): Promise<JourneyOwner> {
  const claims = await getVerifiedClaims(event);
  if (
    !claims?.sub ||
    claims.token_use !== "id" ||
    (claims.email_verified !== true && claims.email_verified !== "true") ||
    typeof claims.email !== "string"
  )
    throw new JourneyError(
      401,
      "Entre com um e-mail confirmado para continuar.",
    );
  return {
    sub: claims.sub,
    email: claims.email.trim().toLowerCase(),
    name: typeof claims.name === "string" ? claims.name : "",
  };
}
function present(row: any) {
  if (!row) return null;
  const c = parseJson<any>(row.plan_contract, {});
  return {
    offer: {
      name: c.name,
      monthly_price: c.monthly_price,
      max_members: c.max_members,
      max_campuses: c.max_campuses,
      features: c.features,
    },
    id: row.id,
    mode: row.mode,
    status: row.status,
    plan_id: row.plan_id,
    church_name: row.church_name,
    contact_name: row.contact_name,
    contact_phone: row.contact_phone,
    document: row.document,
    organization_id: row.organization_id,
    proposal_id: row.proposal_id,
    trial_started_at: row.trial_started_at,
    trial_expires_at: row.trial_expires_at,
    created_at: row.created_at,
    can_start_trial: row.status === "TRIAL_READY",
    studio_url: row.organization_id ? "https://studio.faithhubs.com" : null,
  };
}
export async function publicJourneyHandler(event: APIGatewayProxyEvent) {
  try {
    const method =
      (event as any).requestContext?.http?.method || event.httpMethod;
    if (method === "OPTIONS") return corsPreflight();
    const path = ((event as any).rawPath || event.path || "").replace(
      /\/+$/,
      "",
    );
    const limit = await checkRateLimit(event, {
      maxRequests: method === "GET" ? 100 : 15,
      windowSeconds: 60,
      identifierPrefix: `journey-${method}`,
    });
    if (!limit.allowed) return limit.errorResponse!;
    if (method === "GET" && path.endsWith("/offers"))
      return apiResponse(200, await publicOffers());
    if (path.includes("/admin")) {
      const auth = await requireAuth(event);
      if ("errorResponse" in auth) return auth.errorResponse;
      const role = enforceRole(auth.user, ["SUPERADMIN"]);
      if (!role.allowed) return role.errorResponse!;
      const scope = enforceTenant(
        auth.user,
        event.headers?.["x-organization-id"],
      );
      if (!scope.allowed) return scope.errorResponse!;
      if (method === "GET") {
        const { rows } = await query(
          "SELECT id,church_name,contact_name,owner_email,contact_phone,plan_id,mode,status,organization_id,trial_started_at,trial_expires_at,created_at FROM saas_acquisitions ORDER BY created_at DESC LIMIT 200",
          [],
        );
        return apiResponse(200, { requests: rows });
      }
      const id = path.match(/\/admin\/([0-9a-f-]{36})\/approve$/)?.[1];
      if (method === "POST" && id)
        return apiResponse(200, await approveTrial(id, auth.user.email));
      return apiResponse(404, { message: "Ação não encontrada." });
    }
    const owner = await ownerOf(event);
    if (method === "GET" && path.endsWith("/current"))
      return apiResponse(200, {
        request: present(await getAcquisition(owner)),
      });
    if (method === "POST" && path.endsWith("/requests")) {
      const result = await createAcquisition(
        owner,
        JSON.parse(event.body || "{}"),
      );
      return apiResponse(200, { request: present(result) });
    }
    const match = path.match(
      /\/requests\/([0-9a-f-]{36})(?:\/(checkout|start-trial))?$/,
    );
    if (!match) return apiResponse(404, { message: "Caminho não encontrado." });
    const row = await getAcquisition(owner, match[1]);
    if (!row)
      return apiResponse(404, { message: "Solicitação não encontrada." });
    if (method === "GET") return apiResponse(200, { request: present(row) });
    if (method === "POST" && match[2] === "checkout") {
      const proposal = await createPublicProposal(
        owner,
        row.id,
        JSON.parse(event.body || "{}"),
      );
      return acceptProposal({
        ...event,
        pathParameters: { token: proposal.token },
        body: JSON.stringify({ termsAccepted: true }),
      });
    }
    if (method === "POST" && match[2] === "start-trial") {
      const auth = await requireAuth(event);
      if ("errorResponse" in auth) return auth.errorResponse;
      const role = enforceRole(auth.user, ["ADMIN", "PASTOR"]);
      if (!role.allowed) return role.errorResponse!;
      const scope = enforceTenant(auth.user, row.organization_id);
      if (!scope.allowed) return scope.errorResponse!;
      if (
        row.mode !== "TRIAL" ||
        row.plan_id !== "CONECTAR" ||
        !row.organization_id
      )
        throw new JourneyError(409, "Teste indisponível.");
      const latest = await startTrial(owner, row.id, row.organization_id);
      await logSecurityEvent({
        organizationId: row.organization_id,
        user: auth.user,
        action: "START_CONNECT_TRIAL",
        resource: "organizations",
        resourceId: row.organization_id,
        details: { acquisition: row.id, expires: latest.trial_expires_at },
        event,
      });
      return apiResponse(200, { request: present(latest) });
    }
    return apiResponse(404, { message: "Ação não encontrada." });
  } catch (error) {
    if (error instanceof JourneyError)
      return apiResponse(error.status, { message: error.message });
    if (error instanceof SyntaxError)
      return apiResponse(400, { message: "Requisição inválida." });
    console.error("Public journey failed", { name: (error as Error).name });
    return apiResponse(503, {
      message:
        "Não foi possível concluir agora. Seus dados confirmados foram preservados; tente novamente.",
    });
  }
}
