import { isNativeResourceType, nativeResourceDefinition } from "./model";
import type { AuthorizeResult, Resource } from "./contract";
import { HttpAuthzError } from "./errors";
import { readRegisteredResource, registeredResourceId } from "./resource-store";

/** Shared by fresh checks and policy writes; never cache resource availability. */
export async function registeredResourceGate(resource: Resource, signal?: AbortSignal): Promise<AuthorizeResult | null> {
  if (!isNativeResourceType(resource.type)) return null;
  try {
    const { app, appId } = await nativeResourceDefinition(resource.type);
    const record = await readRegisteredResource(registeredResourceId(resource.type, resource.id), signal);
    const denied = (via: string, unavailable = false): AuthorizeResult => ({ decision: "DENY",
      reason: unavailable ? "AUTHZ_UNAVAILABLE" : "NO_CAPABILITY", retriable: unavailable, ttl_seconds: 0, via });
    if (!record) return denied("resource_not_registered");
    if (record.issuer !== process.env.OIDC_ISSUER?.trim() || (!app || record.app_id !== appId)) return denied("installation_disabled");
    return record.state === "active" ? null : denied("resource_pending", true);
  } catch (error) {
    console.warn("[cas/resources] Availability check failed", { name: error instanceof Error ? error.name : "UnknownError" });
    return { decision: "DENY", reason: "AUTHZ_UNAVAILABLE", retriable: true, ttl_seconds: 0, via: "resource_state_unavailable" };
  }
}

export async function requireRegisteredResource(resource: Resource): Promise<void> {
  const result = await registeredResourceGate(resource);
  if (result) throw new HttpAuthzError(result.retriable ? 503 : 403,
    result.retriable ? "AUTHZ_UNAVAILABLE" : "FORBIDDEN", `Resource is unavailable: ${result.via}`);
}
