import { resourceApp } from "@/lib/agentic-apps/service-binding";
import type { AuthorizeResult, Resource } from "./contract";
import { HttpAuthzError } from "./errors";
import { readRegisteredResource } from "./resource-store";

/** Shared by fresh checks and policy writes; never cache resource availability. */
export async function registeredResourceGate(resource: Resource, signal?: AbortSignal): Promise<AuthorizeResult | null> {
  if (resource.type !== "app_resource") return null;
  try {
    const record = await readRegisteredResource(resource.id, signal);
    const denied = (via: string, unavailable = false): AuthorizeResult => ({ decision: "DENY",
      reason: unavailable ? "AUTHZ_UNAVAILABLE" : "NO_CAPABILITY", retriable: unavailable, ttl_seconds: 0, via });
    if (!record) return denied("resource_not_registered");
    if (record.issuer !== process.env.OIDC_ISSUER?.trim() || !resourceApp(record.app_id)) return denied("installation_disabled");
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
