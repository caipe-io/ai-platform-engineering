import type { AgenticAppManifest, ConfiguredAgenticApp } from "@/types/agentic-app";
import { buildAgenticAppPublicPath } from "./runtime";

/** Only these declared routes delegate authentication to the app's MCP server. */
export function externalMcpRoute(
  manifest: AgenticAppManifest, method: string, path: string,
): "protocol" | "metadata" | "schema" | null {
  const mcp = manifest.api.mcp;
  if (!mcp) return null;
  if (["GET", "HEAD"].includes(method)) {
    if (path === mcp.metadataPath) return "metadata";
    if (path === `${mcp.path}/openapi.json`) return "schema";
  }
  return path === mcp.path && ["GET", "HEAD", "POST", "DELETE"].includes(method)
    ? "protocol" : null;
}

/** Resolve discovery for both stable root MCP URLs and hosted app URLs. */
export function appForMcpResource(apps: ConfiguredAgenticApp[], resource: string): ConfiguredAgenticApp | null {
  const matches = apps.filter(app => {
    const mcp = app.manifest.api.mcp;
    return app.installation.installed && app.installation.enabled && mcp &&
      (resource === `${buildAgenticAppPublicPath(app.installation.appId)}${mcp.path}` || resource === mcp.path);
  });
  if (matches.length > 1) throw new Error("Ambiguous MCP protected resource");
  return matches[0] ?? null;
}
