import { loadConfiguredAgenticApps } from "./config";

export interface AgenticAppAssistantStream {
  appId: string;
  path: string[];
}

/** The installed app declaration is the only source of native stream routing. */
export function findAgenticAppAssistantStream(agentId: string): AgenticAppAssistantStream | null {
  const matches = loadConfiguredAgenticApps().filter((app) =>
    app.installation.installed && app.installation.enabled &&
    app.manifest.ui.assistant?.agentId === agentId &&
    app.manifest.ui.assistant.streamPath,
  );
  if (matches.length > 1) throw new Error(`Multiple installed apps claim assistant ${agentId}`);
  const app = matches[0];
  if (!app) return null;
  const path = app.manifest.ui.assistant?.streamPath;
  if (!path) return null;
  return { appId: app.installation.appId, path: path.slice(1).split("/") };
}
