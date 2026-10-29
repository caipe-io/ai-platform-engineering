import type { AuthorizeResult, Resource } from "./contract";
import { HttpAuthzError } from "./errors";
import { isAppResource } from "./resource-contract";
import { appResourceDefinition, validateRegisteredAction } from "./resource-types";
import { readRegisteredResource } from "./resource-store";

/** Shared by fresh checks and policy writes; never cache resource availability. */
export async function registeredResourceGate(resource: Resource, signal?: AbortSignal, action?: string): Promise<AuthorizeResult | null> {
  if (!isAppResource(resource.type)) return null;
  try {
    const record = await readRegisteredResource(resource.id, signal);
    const denied = (via: string, unavailable = false): AuthorizeResult => ({ decision: "DENY",
      reason: unavailable ? "AUTHZ_UNAVAILABLE" : "NO_CAPABILITY", retriable: unavailable, ttl_seconds: 0, via });
    if (!record) return denied("resource_not_registered");
    if (record.issuer !== process.env.OIDC_ISSUER?.trim()) return denied("resource_issuer_mismatch");
    if (action) validateRegisteredAction(record, action);
    else appResourceDefinition(record.app_id, record.resource_type);
    return record.state === "active" ? null : denied("resource_pending", true);
  } catch (error) {
    if (error instanceof HttpAuthzError && error.status === 403) return { decision: "DENY", reason: "NO_CAPABILITY", retriable: false, ttl_seconds: 0, via: "installation_disabled" };
    if (error instanceof HttpAuthzError && error.status === 400) return { decision: "DENY", reason: "INVALID_REQUEST", retriable: false, ttl_seconds: 0, via: "undeclared_resource_action" };
    console.warn("[cas/resources] Availability check failed", { name: error instanceof Error ? error.name : "UnknownError" });
    return { decision: "DENY", reason: "AUTHZ_UNAVAILABLE", retriable: true, ttl_seconds: 0, via: "resource_state_unavailable" };
  }
}
export async function requireRegisteredResource(resource: Resource, action?: string): Promise<void> {
  const result = await registeredResourceGate(resource, undefined, action);
  if (result) throw new HttpAuthzError(result.retriable ? 503 : result.reason === "INVALID_REQUEST" ? 400 : 403,
    result.retriable ? "AUTHZ_UNAVAILABLE" : result.reason === "INVALID_REQUEST" ? "INVALID_REQUEST" : "FORBIDDEN", `Resource is unavailable: ${result.via}`);
}
