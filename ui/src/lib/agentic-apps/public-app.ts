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
    assistantEnabled: app.manifest.assistant?.enabled !== false,
    ...(app.manifest.assistant?.agentId
      ? { assistantAgentId: app.manifest.assistant.agentId }
      : {}),
    ...(app.manifest.assistant?.label
      ? { assistantLabel: app.manifest.assistant.label }
      : {}),
    ...(app.manifest.assistant?.agentName
      ? { assistantAgentName: app.manifest.assistant.agentName }
      : {}),
    ...(app.manifest.assistant?.maxContextBytes
      ? { assistantMaxContextBytes: app.manifest.assistant.maxContextBytes }
      : {}),
  };
}
