import { canLaunchAgenticApp, type AgenticAppUserContext } from "@/lib/agentic-apps/access";
import { resourceApp } from "@/lib/agentic-apps/service-binding";
import type { PlatformIdentity } from "@/lib/auth/platform-identity";
import type { DecisionContext } from "./contract";
import { emitDecisionAudit, emitGrantAudit } from "./audit";
import { checkDelegationPermission } from "./engines/openfga";
import { HttpAuthzError } from "./errors";
import { reconcileTupleDiff } from "./reconcile";
import type { RegisteredResource, ResourceRegistration } from "./resource-contract";
import { activateResource, registeredResourceId, reserveResource } from "./resource-store";

export class PendingResourceRegistrationError extends HttpAuthzError {
  constructor(readonly record: RegisteredResource, cause: unknown) {
    super(503, "AUTHZ_UNAVAILABLE", "Registration outcome is not confirmed; inspect or retry the same registration");
    this.name = "PendingResourceRegistrationError";
    this.cause = cause;
  }
}

/** The interactive adapter supplies the verified user; services cannot select an owner. */
export async function registerResource(
  identity: PlatformIdentity, intent: ResourceRegistration, userContext: AgenticAppUserContext, ctx: DecisionContext,
): Promise<RegisteredResource> {
  if (identity.subject.type !== "user") throw new HttpAuthzError(403, "FORBIDDEN", "Register resources through a signed-in user session");
  if (identity.issuer !== process.env.OIDC_ISSUER?.trim() || !Number.isFinite(identity.expiresAt) || identity.expiresAt * 1000 <= Date.now()) {
    throw new HttpAuthzError(401, "NOT_AUTHENTICATED", "A current platform identity is required");
  }
  const app = resourceApp(intent.app_id);
  if (!app || !canLaunchAgenticApp(app, userContext)) throw new HttpAuthzError(403, "FORBIDDEN", "Resource integration is not available to this user");
  if (intent.owner_team) {
    const resource = { type: "team" as const, id: intent.owner_team };
    // Fresh team membership includes team admins through the model's member relation.
    const result = await checkDelegationPermission({ subject: identity.subject, resource, action: "read" }, AbortSignal.timeout(5000));
    emitDecisionAudit(identity.subject, resource, "read", result, ctx);
    if (result.decision !== "ALLOW") throw new HttpAuthzError(result.retriable ? 503 : 403,
      result.retriable ? "AUTHZ_UNAVAILABLE" : "FORBIDDEN", "Current team membership is required for team ownership");
  }
  const id = registeredResourceId(identity.issuer, intent.app_id, intent.kind, intent.local_id);
  const record = await reserveResource({ _id: id, issuer: identity.issuer, app_id: intent.app_id,
    kind: intent.kind, local_id: intent.local_id, creator: identity.subject,
    owner: intent.owner_team ? { type: "team", id: intent.owner_team } : { type: "user", id: identity.subject.id },
    state: "pending", created_at: new Date().toISOString() });
  if (record.state === "active") return record;
  const object = `app_resource:${id}`;
  const owner = record.owner.type === "team" ? `team:${record.owner.id}#member` : `user:${record.owner.id}`;
  // Metadata stays pending until the owner projection is confirmed. An ambiguous
  // write is retried toward the same immutable owner, never compensated away.
  const auditIntent = { resource: { type: "app_resource" as const, id }, grantee: record.owner, capability: "manage" as const };
  const auditContext = { ...ctx, caller: identity.subject };
  try {
    const result = await reconcileTupleDiff({ writes: [{ user: owner, relation: "owner", object }], deletes: [] },
      { ...auditContext, source: "app_resource_register" });
    if (!result.enabled) throw new HttpAuthzError(503, "AUTHZ_UNAVAILABLE", "Resource registration requires OpenFGA permission updates");
    const active = await activateResource(id);
    await emitGrantAudit("grant", auditIntent, auditContext, { registration: active });
    return active;
  } catch (error) {
    await emitGrantAudit("grant", auditIntent, auditContext,
      { outcome: "error", reasonCode: "RESOURCE_REGISTRATION_UNCONFIRMED", registration: record });
    console.warn("[cas/resources] Registration not confirmed", { correlationId: ctx.correlationId,
      name: error instanceof Error ? error.name : "UnknownError" });
    throw new PendingResourceRegistrationError(record, error);
  }
}
