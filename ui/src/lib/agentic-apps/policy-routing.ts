import type {
  AgenticAppManifest,
  AgenticAppPolicyAction,
} from "@/types/agentic-app";

/** Resolve the least-privilege action for one proxied request. */
export function resolveAgenticAppHttpPolicyAction(
  manifest: AgenticAppManifest,
  method: string,
  path: string,
): AgenticAppPolicyAction | undefined {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = normalizePath(path);
  const policies = manifest.access.policyActions;
  const routePolicy = policies.find(
    (candidate) =>
      candidate.method === normalizedMethod
      && typeof candidate.path === "string"
      && routeMatches(candidate.path, normalizedPath),
  );
  if (routePolicy) return routePolicy;

  // A method-only `proxy:METHOD` action is the backwards-compatible v1
  // contract. When any method-specific route exists, undeclared paths fail
  // closed instead of falling back to the broad action.
  if (policies.some((candidate) => candidate.method === normalizedMethod)) {
    return undefined;
  }
  return policies.find((candidate) => candidate.action === `proxy:${normalizedMethod}`);
}

function routeMatches(template: string, actual: string): boolean {
  const expected = normalizePath(template).split("/").filter(Boolean);
  const received = actual.split("/").filter(Boolean);
  if (expected.length !== received.length) return false;
  return expected.every(
    (segment, index) => segment.startsWith(":") || segment === received[index],
  );
}

function normalizePath(value: string): string {
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}
