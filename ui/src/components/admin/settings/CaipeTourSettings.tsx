"use client";

import { useEffect, useState } from "react";
import { PRODUCT_TOURS, type ProductTourId } from "@/lib/product-tour-catalog";
import { normalizeEnabledTours } from "@/lib/caipe-tour-policy";
import { useCaipeTourStore } from "@/store/caipe-tour-store";
import { SettingsCard } from "@/components/settings/shared/SettingsCard";
import { Button } from "@/components/ui/button";

export function CaipeTourSettings({ readOnly = false }: { readOnly?: boolean }): React.ReactElement {
  const [selected, setSelected] = useState<ProductTourId[]>([]);
  const [saved, setSaved] = useState<ProductTourId[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/admin/platform-config", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || payload?.success !== true) throw new Error(payload?.error || "Could not load CAIPE Tour policy");
        if (cancelled) return;
        const ids = normalizeEnabledTours(payload.data?.caipe_tour?.enabled_tours);
        setSelected(ids); setSaved(ids);
      }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load CAIPE Tour policy"); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    setSaving(true); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/admin/platform-config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caipe_tour: { enabled_tours: selected } }) });
      const payload = await response.json();
      if (!response.ok || payload?.success !== true) throw new Error(payload?.error || "Could not save CAIPE Tour policy");
      setSaved([...selected]); setMessage("CAIPE Tour availability saved.");
      await useCaipeTourStore.getState().refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save CAIPE Tour policy"); }
    finally { setSaving(false); }
  };
  const disabled = readOnly || !loaded || saved === null || saving;
  return <SettingsCard title="CAIPE Tour" description="Choose which tours are available to your users. Permissions and enabled features still apply; users can turn tours off for their own account.">
    {!loaded && <p role="status" className="text-sm text-muted-foreground">Loading CAIPE Tour policy…</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      {(Object.entries(PRODUCT_TOURS) as [ProductTourId, typeof PRODUCT_TOURS[ProductTourId]][]).map(([id, tour]) => <label key={id} className="flex items-start gap-3 rounded-lg border p-3">
        <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-primary" checked={selected.includes(id)} disabled={disabled} onChange={(event) => { const checked = event.target.checked; setMessage(null); setSelected((ids) => normalizeEnabledTours(checked ? [...ids, id] : ids.filter((item) => item !== id))); }} />
        <span className="min-w-0"><span className="text-sm font-medium">{tour.title}</span><span className="mt-1 block text-xs text-muted-foreground">{tour.description}</span></span>
      </label>)}
    </div>
    <p className="mt-3 text-xs text-muted-foreground">Uncheck every tour to hide CAIPE Tour for everyone. Saved progress is kept. Other sessions update when focused or within a minute.</p>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="mt-3 text-sm text-muted-foreground">{message}</p>}
    <Button className="mt-4" disabled={disabled || JSON.stringify(selected) === JSON.stringify(saved)} onClick={() => void save()}>{saving ? "Saving…" : "Save tours"}</Button>
  </SettingsCard>;
}
