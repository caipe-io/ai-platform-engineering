import { ApiError } from "@/lib/api-middleware";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { resolveAgenticAppIcon } from "../../../app-sdk/agentic-app-manifest.mjs";
import { agenticAppUserContextFromSession, canAccessAgenticApp, canLaunchAgenticApp } from "./access";
import { getAgenticAppAgentStreams, isAgenticAppsEnabled, loadConfiguredAgenticApps } from "./config";
import { supportsAssistantClient } from "./assistant-clients";

/** Apply only after the caller's agent CAS check; app metadata never grants agent access. */
export function projectAgentAppIdentity<T extends DynamicAgentConfig>(
  agents: T[],
  session: Record<string, unknown>,
  { availableOnly = false }: { availableOnly?: boolean } = {},
): T[] {
  let apps;
  try {
    apps = loadConfiguredAgenticApps(undefined, { includeDisabledIdentity: true });
  } catch (error) {
    console.error("[AgentCatalog] Application configuration is unavailable", error instanceof Error ? error.message : String(error));
    throw new ApiError("Application configuration unavailable", 503);
  }
  const byAgent = new Map<string, {
    app: (typeof apps)[number];
    assistant: NonNullable<(typeof apps)[number]["manifest"]["ui"]["assistant"]>;
  }>();
  for (const app of apps) {
    const primary = app.manifest.ui.assistant;
    const assistants = [
      ...getAgenticAppAgentStreams(app).map((stream) => ({ name: "", label: "", ...stream })),
      ...(primary && !primary.streamPath ? [primary] : []),
    ];
    for (const assistant of assistants) {
      if (byAgent.has(assistant.agentId)) throw new ApiError("Ambiguous application agent ownership", 503);
      byAgent.set(assistant.agentId, { app, assistant });
    }
  }
  const user = agenticAppUserContextFromSession(session);
  const client = session.authMethod === "bearer" &&
    session.authorizedParty === (process.env.KEYCLOAK_WEBEX_BOT_CLIENT_ID?.trim() || "caipe-webex-bot") ? "webex" : "webui";
  return agents.flatMap((agent) => {
    // Ignore any stale or user-supplied projection stored in an agent document.
    const clean = { ...agent };
    Reflect.deleteProperty(clean, "presentation");
    const owner = byAgent.get(String(agent._id));
    if (!owner) return [clean];
    const { app, assistant } = owner;
    if (!canAccessAgenticApp(app, user)) return [];
    const available = isAgenticAppsEnabled() && canLaunchAgenticApp(app, user) &&
      !(assistant.streamPath && session.isServiceAccount === true) &&
      (!assistant.streamPath || supportsAssistantClient(assistant, client));
    if (availableOnly && !available) return [];
    const icon = resolveAgenticAppIcon(app.manifest.id, app.manifest.catalog?.icon);
    return [{ ...clean, presentation: {
      app: { id: app.installation.appId, name: app.manifest.displayName, ownsRuntime: Boolean(assistant.streamPath), ...(icon ? { icon } : {}) },
      available,
    } }];
  });
}
