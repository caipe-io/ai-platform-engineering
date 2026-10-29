"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SettingsCard } from "@/components/settings/shared/SettingsCard";
import { ConnectionGuideButtons } from "./AssistantConnectionGuidance";
import { validateConnectionGuidance, type AssistantConnectionGuide } from "@/lib/agentic-apps/connection-guidance";

export function ConnectionGuidanceSettings({ readOnly = false }: { readOnly?: boolean }) {
  const [apps, setApps] = useState<{ appId: string; displayName: string }[]>([]);
  const [appId, setAppId] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/admin/agentic-app-guidance", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Could not load assistant apps.");
      const data = await response.json(); if (!controller.signal.aborted) setApps(data.data?.items ?? []);
    }).catch((reason) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, []);
  return <SettingsCard title="Assistant connection guidance" description="Publish per-app instructions for Webex, Slack, or another messaging channel. These instructions do not link identities or grant agent access.">
    <label className="block text-sm">Agentic App<Select value={appId} onChange={(event) => setAppId(event.target.value)}><option value="">Choose an app</option>{apps.map((app) => <option key={app.appId} value={app.appId}>{app.displayName}</option>)}</Select></label>
    {error && <p role="alert">{error}</p>}
    {appId && <GuideEditor key={appId} appId={appId} readOnly={readOnly} />}
  </SettingsCard>;
}

function GuideEditor({ appId, readOnly }: { appId: string; readOnly: boolean }) {
  const [guides, setGuides] = useState<AssistantConnectionGuide[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const endpoint = `/api/agentic-apps/${encodeURIComponent(appId)}/connection-guidance`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("Could not load connection instructions.");
      const data = await response.json();
      if (!controller.signal.aborted) { setGuides(data.data?.guides ?? []); setSaved(JSON.stringify(data.data?.guides ?? [])); }
    }).catch((reason) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [endpoint]);
  const edit = (index: number, patch: Partial<AssistantConnectionGuide>) => { setGuides((current) => current.map((guide, i) => i === index ? { ...guide, ...patch } : guide)); setMessage(""); };
  const save = async () => {
    setError(""); setMessage("");
    try {
      const snapshot = validateConnectionGuidance(guides);
      setSaving(true);
      const response = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ guides: snapshot }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || data.error || "Could not save instructions.");
      setSaved(JSON.stringify(snapshot)); setGuides(snapshot); setMessage("Connection guidance saved.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save instructions."); }
    finally { setSaving(false); }
  };
  return <div className="mt-4 space-y-4">
    <fieldset disabled={readOnly || saved === null || saving} className="space-y-4">
      {guides.map((guide, index) => <div key={index} className="space-y-2 rounded-lg border p-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={guide.enabled} onChange={(event) => edit(index, { enabled: event.target.checked })} />Show this connection guide</label>
        <label className="block text-sm">Channel ID<Input value={guide.id} onChange={(event) => edit(index, { id: event.target.value })} placeholder="webex" /></label>
        <label className="block text-sm">Button label<Input value={guide.label} maxLength={60} onChange={(event) => edit(index, { label: event.target.value })} /></label>
        <label className="block text-sm">Button logo<Select value={guide.logo ?? ""} onChange={(event) => edit(index, { logo: event.target.value === "webex" ? "webex" : undefined })}><option value="">None</option><option value="webex">Webex</option></Select></label>
        <label className="block text-sm">Popup title<Input value={guide.title} maxLength={120} onChange={(event) => edit(index, { title: event.target.value })} /></label>
        <label className="block text-sm">Instructions (Markdown)<Textarea rows={6} value={guide.markdown} maxLength={8192} onChange={(event) => edit(index, { markdown: event.target.value })} placeholder="Search for the configured bot address and start a direct conversation." /></label>
        <label className="block text-sm">Action label (optional)<Input value={guide.action_label} onChange={(event) => edit(index, { action_label: event.target.value })} /></label>
        <label className="block text-sm">Action URL (optional)<Input value={guide.action_url} onChange={(event) => edit(index, { action_url: event.target.value })} placeholder="/api/auth/webex-link/start" /></label>
        <Button type="button" variant="outline" onClick={() => setGuides((current) => current.filter((_, i) => i !== index))}>Remove guide</Button>
      </div>)}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={guides.length >= 5} onClick={() => setGuides((current) => [...current, { id: `channel-${current.length + 1}`, enabled: false, label: "Connect", title: "Connection instructions", markdown: "", action_label: "", action_url: "" }])}>Add connection guide</Button>
        <Button type="button" disabled={JSON.stringify(guides) === saved} onClick={() => void save()}>{saving ? "Saving…" : "Save connection guidance"}</Button>
      </div>
    </fieldset>
    <div className="flex flex-wrap gap-2" aria-label="Connection guide preview"><ConnectionGuideButtons guides={guides} /></div>
    {message && <p role="status">{message}</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
