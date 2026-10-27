import type { AssistantConfiguration } from "../../../app-sdk/assistant-options.mjs";
import type { AppAssistantContext } from "../../../app-sdk";

export const HOST_ASSISTANT_STATE_EVENT = "caipe.agenticApp.assistant.state";
export const HOST_ASSISTANT_EVENT = "caipe.agenticApp.assistant.request";
export function requestHostAssistant(appId: string, context?: AppAssistantContext, open = true): void {
  window.dispatchEvent(new CustomEvent(HOST_ASSISTANT_EVENT, { detail: { appId, context, open } }));
}

export function configureHostAssistant(appId: string, configuration: AssistantConfiguration): void {
  window.dispatchEvent(new CustomEvent(HOST_ASSISTANT_EVENT, { detail: { appId, configuration } }));
}
