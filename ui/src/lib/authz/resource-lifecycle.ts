import { randomUUID } from "crypto";
import type { PlatformIdentity } from "@/lib/auth/platform-identity";
import { getRealmUserByIdOrNull } from "@/lib/rbac/keycloak-admin";
import { emitDecisionAudit, emitGrantAudit } from "./audit";
import type { DecisionContext } from "./contract";
import { assertEmptyResourceGraph, checkDelegationPermission, checkRetiredResourceOwner } from "./engines/openfga";
import { HttpAuthzError } from "./errors";
import { reconcileTupleDiff } from "./reconcile";
import { registeredResource, resourceOwnerObject, resourceOwnerVersion, type RegisteredResource, type ResourceOwner } from "./resource-contract";
import { readRegisteredResource, updateResourceLifecycle } from "./resource-store";
import { requireResourceTeamMember, requireResourceUser } from "./resources";

/** The last owner can inspect a retirement receipt, never use or regrant it. */
export async function requireResourceOwner(record: RegisteredResource, identity: PlatformIdentity, ctx: DecisionContext): Promise<void> {
  const resource = registeredResource(record);
  const result = record.state === "retired" ? await checkRetiredResourceOwner(record, identity.subject) :
    await checkDelegationPermission({ subject: identity.subject, resource, action: "owner" }, AbortSignal.timeout(5000));
  emitDecisionAudit(identity.subject, resource, record.state === "retired" ? "inspect_retirement" : "owner", result, ctx);
  if (result.decision !== "ALLOW") throw new HttpAuthzError(result.retriable ? 503 : 403,
    result.retriable ? "AUTHZ_UNAVAILABLE" : "FORBIDDEN", "Current resource ownership is required");
}

async function ownedSnapshot(id: string, version: string, identity: PlatformIdentity, ctx: DecisionContext): Promise<RegisteredResource> {
  requireResourceUser(identity);
  const record = await readRegisteredResource(id);
  if (!record) throw new HttpAuthzError(404, "INVALID_REQUEST", "Resource not found");
  if (record.issuer !== identity.issuer) throw new HttpAuthzError(403, "FORBIDDEN", "Resource issuer mismatch");
  await requireResourceOwner(record, identity, ctx);
  if (resourceOwnerVersion(record) !== version) throw new HttpAuthzError(409, "INVALID_REQUEST", "Ownership changed; reload before retrying");
  return record;
}

export async function transferResourceOwner(
  id: string, version: string, owner: ResourceOwner, identity: PlatformIdentity, ctx: DecisionContext,
): Promise<RegisteredResource> {
  const previous = await ownedSnapshot(id, version, identity, ctx);
  if (previous.state !== "active") throw new HttpAuthzError(409, "INVALID_REQUEST", "Only active resources can change owner");
  if (owner.type === "team") await requireResourceTeamMember(identity, owner.id, ctx);
  else if (owner.id !== identity.subject.id) {
    const user = await getRealmUserByIdOrNull(owner.id);
    if (!user || user.id !== owner.id || user.enabled !== true || user.serviceAccountClientId) throw new HttpAuthzError(400, "INVALID_REQUEST", "The new owner must be an enabled human user");
  }
  const next = { ...previous, owner, owner_version: randomUUID() };
  const auditContext = { ...ctx, caller: identity.subject };
  const intent = { resource: registeredResource(previous), grantee: owner, capability: "owner" };
  const lifecycle = { operation: "transfer" as const, previous_owner: previous.owner, owner,
    previous_owner_version: version, owner_version: next.owner_version };
  try {
    // Prepare an isolated node. Failed, concurrent or delayed preparations cannot
    // change live ownership: only the Mongo snapshot swap publishes this node.
    const object = resourceOwnerObject(next);
    await assertEmptyResourceGraph(object);
    const user = owner.type === "team" ? `team:${owner.id}#member` : `user:${owner.id}`;
    const result = await reconcileTupleDiff({ writes: [{ user, relation: "owner", object }], deletes: [] },
      { ...auditContext, source: "resource_transfer_prepare" });
    if (!result.enabled) throw new HttpAuthzError(503, "AUTHZ_UNAVAILABLE", "Ownership transfer requires permission updates");
    const stored = await updateResourceLifecycle(previous, { owner, owner_version: next.owner_version });
    await emitGrantAudit("grant", intent, auditContext, { registration: stored, lifecycle });
    return stored;
  } catch (error) {
    await emitGrantAudit("grant", intent, auditContext, { outcome: "error", reasonCode: "RESOURCE_TRANSFER_UNCONFIRMED", lifecycle });
    throw error;
  }
}

export async function retireResource(id: string, version: string, identity: PlatformIdentity, ctx: DecisionContext): Promise<RegisteredResource> {
  const previous = await ownedSnapshot(id, version, identity, ctx);
  if (previous.state === "retired") return previous;
  const auditContext = { ...ctx, caller: identity.subject };
  const intent = { resource: registeredResource(previous), grantee: previous.owner, capability: "owner" };
  const lifecycle = { operation: "retire" as const, previous_owner: previous.owner, owner: previous.owner, previous_owner_version: version, owner_version: version };
  try {
    // Keep the identity as a tombstone. Old grants and delayed writes cannot
    // reopen it; every decision checks the registry before and after OpenFGA.
    const stored = await updateResourceLifecycle(previous, { state: "retired", retired_at: new Date().toISOString(), retired_by: identity.subject });
    await emitGrantAudit("revoke", intent, auditContext, { registration: stored, lifecycle });
    return stored;
  } catch (error) {
    await emitGrantAudit("revoke", intent, auditContext, { outcome: "error", reasonCode: "RESOURCE_RETIREMENT_UNCONFIRMED", lifecycle });
    throw error;
  }
}
