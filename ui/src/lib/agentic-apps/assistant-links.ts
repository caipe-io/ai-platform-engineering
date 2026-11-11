import type { AssistantOptions } from "../../../app-sdk/assistant-options.mjs";

export const assistantConversationQueryKeys = (options?: AssistantOptions): string[] =>
  ["assistant_chat", ...(options?.legacyConversationQueryParams ?? [])];

/** Resolve exact conversation aliases; invalid/ambiguous links never select a fallback. */
export function readAssistantDeepLink(search: string, options?: AssistantOptions): { requested: boolean; id?: string; error?: string } {
  const params = new URLSearchParams(search);
  const ids = assistantConversationQueryKeys(options).flatMap(key => params.getAll(key));
  if (!ids.length) return { requested: false };
  if (new Set(ids).size !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ids[0]))
    return { requested: true, error: "Invalid or conflicting assistant conversation link" };
  return { requested: true, id: ids[0] };
}
