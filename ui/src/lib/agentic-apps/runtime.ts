import type { ConfiguredAgenticApp } from "@/types/agentic-app";

export const AGENTIC_APP_RUNTIME_BASE = "/api/agentic-apps/runtime";
export const AGENTIC_APP_PUBLIC_BASE = "/apps";

export function buildAgenticAppPublicPath(appId: string, path: string[] = []): string {
  const suffix = path.map((part) => encodeURIComponent(part)).join("/");
  return `${AGENTIC_APP_PUBLIC_BASE}/${encodeURIComponent(appId)}${suffix ? `/${suffix}` : ""}`;
}

export function buildAgenticAppRuntimePath(appId: string, path: string[] = []): string {
  const suffix = path.map((part) => encodeURIComponent(part)).join("/");
  return `${AGENTIC_APP_RUNTIME_BASE}/${encodeURIComponent(appId)}${suffix ? `/${suffix}` : ""}`;
}

export function resolveAgenticAppOrigin(app: ConfiguredAgenticApp): string | null {
  return app.installation.runtimeOriginOverride ?? app.manifest.runtime.origin ?? null;
}

export function buildAgenticAppTargetUrl(
  app: ConfiguredAgenticApp,
  path: string[],
  requestUrl: string,
): URL {
  const origin = resolveAgenticAppOrigin(app);
  if (!origin) throw new Error("runtime origin is not configured");
  const target = new URL(origin);
  const encodedPath = path.map((part) => encodeURIComponent(part)).join("/");
  const suffix = encodedPath ? `/${encodedPath}` : "/";
  if (app.manifest.runtime.preserveMountPath) {
    const mountPath = (
      app.installation.runtimeMountPath ?? app.manifest.runtime.mountPath
    ).replace(/\/+$/, "");
    target.pathname = `${mountPath}${suffix}`;
  } else {
    target.pathname = suffix;
  }
  target.search = new URL(requestUrl).search;
  return target;
}

/**
 * Keep same-runtime redirects inside the public Apps mount instead of exposing
 * a private service origin or escaping to the CAIPE root. Cross-origin HTTP(S)
 * redirects are retained for explicit browser flows such as an external IdP.
 */
export function rewriteAgenticAppResponseLocation(
  app: ConfiguredAgenticApp,
  appId: string,
  target: URL,
  location: string | null,
): string | null {
  if (!location) return null;

  let resolved: URL;
  try {
    resolved = new URL(location, target);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return null;
  }
  if (resolved.origin !== target.origin) return resolved.toString();

  const mountPath = (
    app.installation.runtimeMountPath ?? app.manifest.runtime.mountPath
  ).replace(/\/+$/, "");
  let runtimePath = resolved.pathname;
  if (runtimePath === mountPath) {
    runtimePath = "/";
  } else if (runtimePath.startsWith(`${mountPath}/`)) {
    runtimePath = runtimePath.slice(mountPath.length);
  }

  const suffix = runtimePath === "/" ? "" : runtimePath;
  return `${buildAgenticAppPublicPath(appId)}${suffix}${resolved.search}${resolved.hash}`;
}
