"use client";

import { useSession } from "next-auth/react";
import { useCallback, useEffect, useState } from "react";

export function useAgentCatalogView() {
  const { data: session } = useSession();
  const principal = session?.sub || session?.user?.email;
  const key = principal ? `caipe:agent-catalog-view:${principal}` : null;
  const [saved, setSaved] = useState<{ key: string | null; view: "grid" | "list" }>({ key: null, view: "grid" });
  const view = saved.key === key ? saved.view : "grid";
  useEffect(() => {
    const read = () => {
      let next: "grid" | "list" = "grid";
      try { if (key && localStorage.getItem(key) === "list") next = "list"; } catch { /* Storage may be disabled. */ }
      setSaved({ key, view: next });
    };
    read();
    const sync = (event: StorageEvent) => { if (event.key === key) read(); };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [key]);
  const setView = useCallback((next: "grid" | "list") => {
    setSaved({ key, view: next });
    try { if (key) localStorage.setItem(key, next); } catch { /* Keep the in-memory selection usable. */ }
  }, [key]);
  return [view, setView] as const;
}
