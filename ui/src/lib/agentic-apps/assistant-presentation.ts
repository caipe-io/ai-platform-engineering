import type { Session } from "next-auth";

import { validateAssistantConfiguration, type AssistantConfiguration, type AssistantOptions } from "../../../app-sdk/assistant-options.mjs";

export const ASSISTANT_PRESENTATION_EVENT = "caipe.assistant.presentation";
const MAX_AGE_MS = 5 * 60 * 1000;

/** Only bounded presentation choices are shared across tabs, never credentials or access. */
function key(appId: string, agentId: string, session: Session | null): string {
  return "caipe-assistant-presentation:" + JSON.stringify([appId, agentId, session?.sub, session?.user?.email, session?.org, session?.role]);
}

export function rememberAssistantPresentation(appId: string, agentId: string, session: Session | null, configuration: AssistantConfiguration, options?: AssistantOptions): void {
  try {
    validateAssistantConfiguration(configuration, options);
    localStorage.setItem(key(appId, agentId, session), JSON.stringify({ at: Date.now(), configuration }));
    window.dispatchEvent(new Event(ASSISTANT_PRESENTATION_EVENT));
  } catch {
    // Invalid/stale choices or storage restrictions must not block the current app.
  }
}

export function readAssistantPresentation(appId: string, agentId: string, session: Session | null, options?: AssistantOptions): AssistantConfiguration | undefined {
  try {
    const raw = localStorage.getItem(key(appId, agentId, session));
    if (!raw || raw.length > 16384) return;
    const { at, configuration } = JSON.parse(raw);
    if (!Number.isFinite(at) || Date.now() - at < 0 || Date.now() - at > MAX_AGE_MS) return;
    validateAssistantConfiguration(configuration, options);
    return configuration;
  } catch {
    return;
  }
}
