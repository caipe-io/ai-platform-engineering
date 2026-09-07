"use client";

import { useCallback, useEffect, useState } from "react";

interface Project {
  id: string;
  name: string;
}

interface ProjectPickerProps {
  value?: string;
  disabled?: boolean;
  onChange: (value?: string) => void;
}

export function ProjectPicker({ value, disabled, onChange }: ProjectPickerProps) {
  const [items, setItems] = useState<Project[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/user/projects", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error("Projects unavailable");
      setItems(Array.isArray(payload.data?.items) ? payload.data.items : []);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="flex items-center gap-2">
      <select
        aria-label="Project"
        value={value || ""}
        disabled={disabled || loading}
        onChange={(event) => onChange(event.target.value || undefined)}
        className="h-8 max-w-56 rounded-md border border-input bg-background px-2 text-xs"
      >
        <option value="">{loading ? "Loading Projects…" : "No project"}</option>
        {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      {error && (
        <button type="button" className="text-[11px] text-amber-400 underline" onClick={() => void load()}>
          Projects unavailable—retry (unscoped chat still works)
        </button>
      )}
    </div>
  );
}
