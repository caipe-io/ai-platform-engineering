"use client";

import { useCallback, useSyncExternalStore } from "react";

import type { ConversationPresence } from "@/types/conversation-presence";

interface Subscription {
  source: EventSource | null;
  retry?: ReturnType<typeof setTimeout>;
  active: boolean;
  snapshot: ConversationPresence | null;
  listeners: Set<() => void>;
}

// Popup and full chat in one document share a subscription. Separate browser
// documents open separate connections, including duplicated tabs.
const subscriptions = new Map<string, Subscription>();
const noSnapshot = () => null;

function isPresence(value: unknown): value is ConversationPresence {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as ConversationPresence;
  return Array.isArray(snapshot.viewers) && Number.isSafeInteger(snapshot.sessionCount) &&
    snapshot.viewers.every(viewer => viewer && typeof viewer.id === "string" &&
      typeof viewer.name === "string" && Number.isSafeInteger(viewer.sessions) && viewer.sessions > 0) &&
    snapshot.sessionCount === snapshot.viewers.reduce((total, viewer) => total + viewer.sessions, 0);
}

function subscribe(id: string, listener: () => void): () => void {
  if (typeof EventSource === "undefined") return () => {};
  let entry = subscriptions.get(id);
  if (!entry) {
    entry = { source: null, active: true, snapshot: null, listeners: new Set() };
    subscriptions.set(id, entry);
    const current = entry;
    const publish = (snapshot: ConversationPresence | null) => {
      current.snapshot = snapshot;
      current.listeners.forEach(notify => notify());
    };
    let retryMs = 5_000;
    const connect = () => {
      if (!current.active) return;
      const source = new EventSource(`/api/chat/conversations/${encodeURIComponent(id)}/presence`);
      current.source = source;
      source.addEventListener("presence", (event) => {
        try {
          const snapshot: unknown = JSON.parse((event as MessageEvent<string>).data);
          if (isPresence(snapshot)) {
            retryMs = 5_000;
            publish(snapshot);
          } else publish(null);
        }
        catch { publish(null); }
      });
      source.addEventListener("error", () => {
        if (!current.active || current.source !== source) return;
        publish(null);
        // Own retries so persistent failures back off, including non-200
        // responses while a new conversation is still being saved.
        source.close();
        current.source = null;
        clearTimeout(current.retry);
        current.retry = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 60_000);
      });
      source.addEventListener("access-revoked", () => {
        current.active = false;
        clearTimeout(current.retry);
        source.close();
        publish(null);
      });
    };
    connect();
  }
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (!entry.listeners.size) {
      entry.active = false;
      clearTimeout(entry.retry);
      entry.source?.close();
      subscriptions.delete(id);
    }
  };
}

export function useConversationPresence(id?: string): ConversationPresence | null {
  return useSyncExternalStore(
    useCallback((notify) => id ? subscribe(id, notify) : () => {}, [id]),
    useCallback(() => id ? subscriptions.get(id)?.snapshot ?? null : null, [id]),
    noSnapshot,
  );
}
