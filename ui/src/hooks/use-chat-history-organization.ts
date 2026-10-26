"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { getStorageMode } from "@/lib/storage-config";
import { EMPTY_CHAT_ORGANIZATION, chatHistoryOrganizationForScope, mergeChatHistoryOrganizationScope, parseChatHistoryOrganization, type ChatHistoryOrganization, type ChatHistoryOrganizationScope } from "@/lib/chat-history-organization";

export function useChatHistoryOrganization(identity: string | undefined, scope: ChatHistoryOrganizationScope = "chats") {
  const [loaded, setLoaded] = useState<{ identity: string; value: ChatHistoryOrganization } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const current = useRef(loaded);
  const busy = useRef(false);
  const activeIdentity = useRef(identity);
  useEffect(() => {
    activeIdentity.current = identity;
    let cancelled = false;
    if (!identity) return;
    const load = async () => {
      let value: unknown;
      if (getStorageMode() === "mongodb") value = (await apiClient.getSettings()).preferences?.chat_history;
      else value = JSON.parse(localStorage.getItem(`caipe-chat-organization:${identity}`) ?? "null");
      if (cancelled) return;
      const next = { identity, value: value ? parseChatHistoryOrganization(value) : EMPTY_CHAT_ORGANIZATION };
      current.current = next; setLoaded(next); setError("");
    };
    void load().catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load chat folders"); });
    return () => { cancelled = true; };
  }, [identity, attempt]);
  const update = useCallback(async (change: (value: ChatHistoryOrganization) => ChatHistoryOrganization) => {
    if (!identity || current.current?.identity !== identity || busy.current) return false;
    busy.current = true; setSaving(true);
    try {
      const value = mergeChatHistoryOrganizationScope(current.current.value, scope, change(chatHistoryOrganizationForScope(current.current.value, scope)));
      if (getStorageMode() === "mongodb") await apiClient.updatePreferences({ chat_history: value });
      else localStorage.setItem(`caipe-chat-organization:${identity}`, JSON.stringify(value));
      if (activeIdentity.current !== identity) return false;
      const next = { identity, value }; current.current = next; setLoaded(next); setError("");
      return true;
    } catch (reason) {
      if (activeIdentity.current === identity) setError(reason instanceof Error ? reason.message : "Could not save chat folders");
      return false;
    } finally { busy.current = false; setSaving(false); }
  }, [identity, scope]);
  return { value: chatHistoryOrganizationForScope(loaded?.identity === identity ? loaded?.value ?? EMPTY_CHAT_ORGANIZATION : EMPTY_CHAT_ORGANIZATION, scope),
    ready: !!identity && loaded?.identity === identity, saving, error, update, retry: () => setAttempt(value => value + 1) };
}
