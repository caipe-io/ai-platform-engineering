import { ApiError } from "@/lib/api-middleware";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { resolveAgenticAppIcon } from "../../../app-sdk/agentic-app-manifest.mjs";
import { agenticAppUserContextFromSession, canAccessAgenticApp, canLaunchAgenticApp } from "./access";
import { loadConfiguredAgenticApps } from "./config";
import { supportsAssistantClient } from "./assistant-clients";

/** Apply only after the caller's agent CAS check; app metadata never grants agent access. */
export function projectAgentAppIdentity<T extends DynamicAgentConfig>(
  agents: T[],
  session: Record<string, unknown>,
  { availableOnly = false }: { availableOnly?: boolean } = {},
): T[] {
  let apps;
  try {
    apps = loadConfiguredAgenticApps();
  } catch (error) {
    console.error("[AgentCatalog] Application configuration is unavailable", error instanceof Error ? error.message : String(error));
    throw new ApiError("Application configuration unavailable", 503);
  }
  const byAgent = new Map<string, (typeof apps)[number]>();
  for (const app of apps) {
    const id = app.manifest.ui.assistant?.agentId;
    if (!id) continue;
    if (byAgent.has(id)) throw new ApiError("Ambiguous application agent ownership", 503);
    byAgent.set(id, app);
  }
  const user = agenticAppUserContextFromSession(session);
  const client = session.authMethod === "bearer" &&
    session.authorizedParty === (process.env.KEYCLOAK_WEBEX_BOT_CLIENT_ID?.trim() || "caipe-webex-bot") ? "webex" : "webui";
  return agents.flatMap((agent) => {
    // Ignore any stale or user-supplied projection stored in an agent document.
    const clean = { ...agent };
    Reflect.deleteProperty(clean, "presentation");
    const app = byAgent.get(String(agent._id));
    if (!app) return [clean];
    if (!canAccessAgenticApp(app, user)) return [];
    const available = canLaunchAgenticApp(app, user) &&
      !(app.manifest.ui.assistant?.streamPath && session.isServiceAccount === true) &&
      (!app.manifest.ui.assistant?.streamPath || supportsAssistantClient(app.manifest.ui.assistant, client));
    if (availableOnly && !available) return [];
    const icon = resolveAgenticAppIcon(app.manifest.id, app.manifest.catalog?.icon);
    return [{ ...clean, presentation: {
      app: { id: app.installation.appId, name: app.manifest.displayName, ...(icon ? { icon } : {}) },
      available,
    } }];
  });
}
