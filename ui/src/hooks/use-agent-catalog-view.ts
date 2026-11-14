"use client";

import { useSession } from "next-auth/react";
import { useCallback, useEffect, useState } from "react";

const VIEWS = ["grid", "list"] as const;
export const AGENT_CARD_SIZES = [
  { id: "compact", label: "Compact", minWidth: 280 },
  { id: "balanced", label: "Balanced", minWidth: 360 },
  { id: "comfortable", label: "Comfortable", minWidth: 440 },
] as const;
const CARD_SIZES = AGENT_CARD_SIZES.map(size => size.id);

function useCatalogPreference<T extends string>(name: string, fallback: T, choices: readonly T[]) {
  const { data: session } = useSession();
  const principal = session?.sub || session?.user?.email;
  const key = principal ? `caipe:agent-catalog-${name}:${principal}` : null;
  const [saved, setSaved] = useState<{ key: string | null; value: T }>({ key: null, value: fallback });
  const value = saved.key === key ? saved.value : fallback;
  useEffect(() => {
    const read = () => {
      let next = fallback;
      try {
        const stored = key ? localStorage.getItem(key) : null;
        if (stored && choices.includes(stored as T)) next = stored as T;
      } catch { /* Storage may be disabled. */ }
      setSaved({ key, value: next });
    };
    read();
    const sync = (event: StorageEvent) => { if (event.key === key || event.key === null) read(); };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [key, fallback, choices]);
  const setValue = useCallback((next: T) => {
    if (!choices.includes(next)) return;
    setSaved({ key, value: next });
    try { if (key) localStorage.setItem(key, next); } catch { /* Keep the in-memory selection usable. */ }
  }, [key, choices]);
  return [value, setValue] as const;
}

export function useAgentCatalogView() {
  return useCatalogPreference("view", "grid", VIEWS);
}

export function useAgentCatalogCardSize() {
  return useCatalogPreference("card-size", "balanced", CARD_SIZES);
}
