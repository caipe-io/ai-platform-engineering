import type { AppAssistantContext } from "../../../app-sdk";

export const HOST_ASSISTANT_EVENT = "caipe.agenticApp.assistant.request";
export function requestHostAssistant(appId: string, context?: AppAssistantContext, open = true): void {
  window.dispatchEvent(new CustomEvent(HOST_ASSISTANT_EVENT, { detail: { appId, context, open } }));
}
