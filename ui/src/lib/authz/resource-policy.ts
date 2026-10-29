import type { AuthorizeResult, Resource } from "./contract";
import { HttpAuthzError } from "./errors";
import { isAppResource, resourceOwnerVersion, type RegisteredResource } from "./resource-contract";
import { appResourceDefinition, validateRegisteredAction } from "./resource-types";
import { readRegisteredResource } from "./resource-store";

/** Shared by fresh checks and policy writes; never cache resource availability. */
export async function registeredResourcePolicy(resource: Resource, signal?: AbortSignal, action?: string): Promise<{
  record?: RegisteredResource; denied: AuthorizeResult | null;
}> {
  if (!isAppResource(resource.type)) return { denied: null };
  try {
    const record = await readRegisteredResource(resource.id, signal);
    const denied = (via: string, unavailable = false): AuthorizeResult => ({ decision: "DENY",
      reason: unavailable ? "AUTHZ_UNAVAILABLE" : "NO_CAPABILITY", retriable: unavailable, ttl_seconds: 0, via });
    if (!record) return { denied: denied("resource_not_registered") };
    if (record.issuer !== process.env.OIDC_ISSUER?.trim()) return { denied: denied("resource_issuer_mismatch") };
    if (record.state === "retired") return { record, denied: denied("resource_retired") };
    if (action) validateRegisteredAction(record, action);
    else appResourceDefinition(record.app_id, record.resource_type);
    return { record, denied: record.state === "active" ? null : denied("resource_pending", true) };
  } catch (error) {
    if (error instanceof HttpAuthzError && error.status === 403) return { denied: { decision: "DENY", reason: "NO_CAPABILITY", retriable: false, ttl_seconds: 0, via: "installation_disabled" } };
    if (error instanceof HttpAuthzError && error.status === 400) return { denied: { decision: "DENY", reason: "INVALID_REQUEST", retriable: false, ttl_seconds: 0, via: "undeclared_resource_action" } };
    console.warn("[cas/resources] Availability check failed", { name: error instanceof Error ? error.name : "UnknownError" });
    return { denied: { decision: "DENY", reason: "AUTHZ_UNAVAILABLE", retriable: true, ttl_seconds: 0, via: "resource_state_unavailable" } };
  }
}
export async function registeredResourceGate(resource: Resource, signal?: AbortSignal, action?: string, ownerVersion?: string): Promise<AuthorizeResult | null> {
  const policy = await registeredResourcePolicy(resource, signal, action);
  if (policy.denied) return policy.denied;
  if (policy.record && ownerVersion && resourceOwnerVersion(policy.record) !== ownerVersion) {
    return { decision: "DENY", reason: "AUTHZ_UNAVAILABLE", retriable: true, ttl_seconds: 0, via: "resource_ownership_changed" };
  }
  return null;
}
export async function requireRegisteredResource(resource: Resource, action?: string): Promise<void> {
  const result = await registeredResourceGate(resource, undefined, action);
  if (result) throw new HttpAuthzError(result.retriable ? 503 : result.reason === "INVALID_REQUEST" ? 400 : 403,
    result.retriable ? "AUTHZ_UNAVAILABLE" : result.reason === "INVALID_REQUEST" ? "INVALID_REQUEST" : "FORBIDDEN", `Resource is unavailable: ${result.via}`);
}
