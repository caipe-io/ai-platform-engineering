import type { Session } from "next-auth";

import {
  validateAssistantConfiguration,
  type AssistantConfiguration,
  type AssistantOptions,
  type MessageActionDeclaration,
} from "../../../app-sdk/assistant-options.mjs";

export const ASSISTANT_PRESENTATION_EVENT = "caipe.assistant.presentation";
const MAX_AGE_MS = 5 * 60 * 1000;

/** Only bounded presentation choices are shared across tabs, never credentials or access. */
function key(appId: string, agentId: string, session: Session | null): string {
  return "caipe-assistant-presentation:" + JSON.stringify([appId, agentId, session?.sub, session?.user?.email, session?.org, session?.role]);
}

/** Declared actions the app enabled for this user; anything not enabled stays hidden. */
export function enabledMessageActions(options?: AssistantOptions, configuration?: AssistantConfiguration): MessageActionDeclaration[] {
  return (options?.messageActions ?? []).filter(action => configuration?.messageActions?.[action.id]?.visible === true);
}

/** The remembered copy is shared across tabs, so it carries presentation only, never per-user action visibility. */
function withoutMessageActions(configuration: AssistantConfiguration): AssistantConfiguration {
  const { messageActions: _omitted, ...presentation } = configuration;
  void _omitted;
  return presentation;
}

export function rememberAssistantPresentation(appId: string, agentId: string, session: Session | null, configuration: AssistantConfiguration, options?: AssistantOptions): void {
  try {
    validateAssistantConfiguration(configuration, options);
    localStorage.setItem(key(appId, agentId, session), JSON.stringify({ at: Date.now(), configuration: withoutMessageActions(configuration) }));
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
    return withoutMessageActions(configuration);
  } catch {
    return;
  }
}
