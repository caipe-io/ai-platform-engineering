"use client";

import { useEffect, useState } from "react";

export function useProjectsEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/admin/platform-config", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) setEnabled(payload.success === true && payload.data?.projects?.enabled === true);
      })
      .catch(() => { if (!cancelled) setEnabled(false); });
    return () => { cancelled = true; };
  }, []);

  return enabled;
}
