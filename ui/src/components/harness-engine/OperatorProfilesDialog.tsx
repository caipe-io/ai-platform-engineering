"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import { getErrorMessage } from "@/lib/error-utils";
import type { HarnessDescriptor } from "@/types/harness-engine";

const endpoint = "/api/admin/harness-engine/operator-profiles";
interface Profile {
  profile_id: string; harness_id: string; base_profile_id: string;
  display_name: string; description: string; model: string; max_turns: number;
}

export function OperatorProfilesDialog({ open, onOpenChange, harnessId, onCreated }: {
  open: boolean; onOpenChange: (open: boolean) => void; harnessId: string;
  onCreated: (profileId: string, maxTurns: number) => Promise<void>;
}) {
  const [harnesses, setHarnesses] = React.useState<HarnessDescriptor[]>([]);
  const [profiles, setProfiles] = React.useState<Profile[]>([]);
  const [baseId, setBaseId] = React.useState("");
  const [id, setId] = React.useState("");
  const [name, setName] = React.useState("");
  const [model, setModel] = React.useState("");
  const [turns, setTurns] = React.useState(20);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError(null); setId(""); setName(""); setModel(""); setBaseId(""); setTurns(20);
    fetch(endpoint, { cache: "no-store" }).then(async response => {
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || result.detail || "Profiles could not be loaded");
      if (!cancelled) { setHarnesses(result.data.harnesses); setProfiles(result.data.profiles); }
    }).catch(cause => { if (!cancelled) setError(getErrorMessage(cause, "Operator profiles are unavailable")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, reload]);
  const bases = harnesses.find(h => h.id === harnessId)?.profiles.filter(p => p.source !== "managed" && p.available) ?? [];
  const saved = profiles.filter(p => p.harness_id === harnessId);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        profile_id: id.trim(), harness_id: harnessId, base_profile_id: baseId,
        display_name: name.trim(), model: model.trim(), max_turns: turns,
      }) });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || (typeof result.detail === "string" ? result.detail : "Profile could not be saved; check the fields"));
      await onCreated(result.data.profile_id, result.data.max_turns);
      onOpenChange(false);
    } catch (cause) { setError(getErrorMessage(cause, "Operator profiles are unavailable")); }
    finally { setSaving(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!saving) onOpenChange(value); }}>
    <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
      <form onSubmit={save} className="space-y-4">
        <DialogHeader><DialogTitle>Operator profiles</DialogTitle>
          <DialogDescription>Create a model and turn default for this runtime. Save a new profile ID for each revision; existing agents and conversations keep their selected profile.</DialogDescription>
        </DialogHeader>
        {saved.length > 0 && <div className="space-y-2"><Label>Revise an existing profile</Label>
          <SearchablePicker options={saved} getOptionKey={p => p.profile_id} getOptionLabel={p => p.display_name}
            onSelect={p => { setBaseId(p.base_profile_id); setName(p.display_name); setModel(p.model); setTurns(p.max_turns); setId(""); }}
            placeholder="Copy settings from a profile" searchPlaceholder="Search profiles" emptyLabel="No profiles" ariaLabel="Copy profile settings" disabled={saving} />
        </div>}
        <div className="space-y-2"><Label htmlFor="operator-base">Worker configuration</Label>
          <SearchablePicker id="operator-base" options={bases} selected={bases.find(p => p.id === baseId)}
            getOptionKey={p => p.id} getOptionLabel={p => p.display_name} onSelect={p => { setBaseId(p.id); if (p.model) setModel(p.model); }}
            placeholder="Select an existing configuration" searchPlaceholder="Search configurations" emptyLabel="No available configurations"
            ariaLabel="Worker configuration" required loading={loading} disabled={saving || loading} />
        </div>
        <div className="space-y-2"><Label htmlFor="operator-id">New profile ID</Label><Input id="operator-id" value={id} onChange={e => setId(e.target.value)} placeholder="managed-sre-v1" pattern="managed-[a-z0-9][a-z0-9-]{0,54}" required disabled={saving} /></div>
        <div className="space-y-2"><Label htmlFor="operator-name">Display name</Label><Input id="operator-name" value={name} onChange={e => setName(e.target.value)} maxLength={100} required disabled={saving} /></div>
        <div className="space-y-2"><Label htmlFor="operator-model">Execution model ID</Label><Input id="operator-model" value={model} onChange={e => setModel(e.target.value)} maxLength={128} required disabled={saving} />
          <p className="text-xs text-muted-foreground">Use an exact model ID supported by this worker’s model provider. Saving does not verify provider availability.</p>
        </div>
        <div className="space-y-2"><Label htmlFor="operator-turns">Default maximum turns</Label><Input id="operator-turns" type="number" min={1} max={100} step={1} value={turns} onChange={e => setTurns(e.target.valueAsNumber)} required disabled={saving} />
          <p className="text-xs text-muted-foreground">Agent authors can override this default from 1 to 100 in Advanced.</p>
        </div>
        <p className="text-xs text-muted-foreground">Connections, credentials, workspace isolation, and tool permissions remain managed by the deployment. A new profile is available to authors of this runtime.</p>
        {error && <div role="alert" className="text-sm text-destructive">{error} <Button type="button" variant="ghost" onClick={() => setReload(v => v + 1)} disabled={saving}>Reload profiles</Button></div>}
        <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button><Button type="submit" disabled={saving || loading || !baseId}>{saving ? "Saving…" : "Create and select profile"}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
