import type { HarnessSandboxInfo } from "@/types/harness-engine";

/** Management links are public operator metadata, never a connection credential. */
export function sandboxPortalUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function readHarnessSandbox(value: unknown): HarnessSandboxInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (item.status !== "configured" || !sandboxPortalUrl(item.portal_url) ||
    !["instance_id", "display_name", "policy_revision", "policy_summary"]
      .every(key => typeof item[key] === "string")) return undefined;
  return {
    instance_id: item.instance_id as string,
    display_name: item.display_name as string,
    portal_url: sandboxPortalUrl(item.portal_url)!,
    policy_revision: item.policy_revision as string,
    policy_summary: item.policy_summary as string,
    status: "configured",
  };
}
