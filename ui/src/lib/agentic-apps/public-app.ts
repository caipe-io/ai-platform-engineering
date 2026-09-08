import type { ConfiguredAgenticApp, PublicAgenticApp } from "@/types/agentic-app";

/** Build the browser-safe catalog record. Runtime origins never cross the BFF. */
export function buildPublicAgenticApp(
  app: ConfiguredAgenticApp,
  canLaunch: boolean,
): PublicAgenticApp {
  return {
    appId: app.installation.appId,
    displayName: app.manifest.displayName,
    description: app.manifest.description,
    href: `/apps/${encodeURIComponent(app.installation.appId)}`,
    canLaunch,
    blockedReasons: canLaunch ? [] : ["unauthorized"],
    categories: app.manifest.catalog?.categories ?? [],
    capabilities: app.manifest.catalog?.capabilities ?? [],
  };
}
