"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NOTIFICATION_CHANNELS, type NotificationChannel } from "@/lib/notifications/channels";
import type { NotificationEventPolicy } from "@/lib/notifications/event-policy";

interface Source { id: string; label: string; events: NotificationEventPolicy[]; }
const CHANNEL_LABELS: Record<NotificationChannel, string> = { in_app: "In-app inbox", web_push: "Browser Web Push", webex: "Webex", slack: "Slack" };
async function request(method = "GET", body?: unknown): Promise<Source[]> {
  const response = await fetch("/api/admin/notifications/events", { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "Could not update notification registration");
  return result.data;
}

function EventEditor({ event, readOnly, onSaved }: { event: NotificationEventPolicy; readOnly: boolean; onSaved: (message?: string) => Promise<void> }): React.ReactElement {
  const [draft, setDraft] = useState(event);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmRetire, setConfirmRetire] = useState(false);
  const disabled = readOnly || draft.locked || Boolean(draft.retired) || saving;
  async function changeLifecycle(action: "retire" | "restore"): Promise<void> {
    setSaving(true); setError("");
    try {
      await request("PATCH", { sourceId: event.sourceId, eventType: event.eventType, revision: event.revision, action });
      await onSaved(action === "retire" ? "Event retired. History is preserved; use Show retired events to restore it." : "Event restored for future notifications. Skipped deliveries are not replayed.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not change event registration"); }
    finally { setSaving(false); }
  }
  async function save(change: FormEvent): Promise<void> {
    change.preventDefault(); setSaving(true); setError("");
    try {
      const { locked: _locked, retired: _retired, deliveryGeneration: _deliveryGeneration, ...policy } = draft; void _locked; void _retired; void _deliveryGeneration;
      await request("PATCH", policy); await onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save policy"); }
    finally { setSaving(false); }
  }
  return <details className="rounded-lg border p-4">
    <summary className="cursor-pointer font-medium">{event.label} <span className="ml-2 text-xs text-muted-foreground">{event.eventType} · {event.retired ? "Retired" : event.enabled ? "Enabled" : "Disabled"}</span></summary>
    <form onSubmit={(change) => void save(change)} className="mt-4 space-y-4">
      {draft.locked && <p className="text-sm text-muted-foreground">Managed by the approval workflow. Only organization admins and configured approvers receive requests. Required inbox delivery cannot be disabled here.</p>}
      <label className="block text-sm">Label<Input value={draft.label} maxLength={100} required disabled={disabled} onChange={(change) => setDraft({ ...draft, label: change.target.value })} /></label>
      <label className="block text-sm">Description<Input value={draft.description} maxLength={300} disabled={disabled} onChange={(change) => setDraft({ ...draft, description: change.target.value })} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} disabled={disabled} onChange={(change) => setDraft({ ...draft, enabled: change.target.checked })} />Enable this event</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.defaultEnabled} disabled={disabled} onChange={(change) => setDraft({ ...draft, defaultEnabled: change.target.checked })} />Enabled by default for eligible subscribers</label>
      <label className="block text-sm">Audience<Select value={draft.audience} disabled={disabled || (draft.sourceId === "platform" && draft.eventType.startsWith("service."))} onChange={(change) => setDraft({ ...draft, audience: change.target.value as NotificationEventPolicy["audience"] })}>
        <option value="recipients">Publisher-selected authorized recipients</option><option value="organization_admins">Organization admins only</option>{draft.locked && <option value="approval_reviewers">Authorized approvers and organization admins</option>}
      </Select></label>
      <fieldset disabled={disabled} className="space-y-2"><legend className="text-sm font-medium">Permitted channels</legend><div className="flex flex-wrap gap-4">{NOTIFICATION_CHANNELS.map((channel) => <label key={channel} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.allowedChannels.includes(channel)} onChange={(change) => setDraft({ ...draft, allowedChannels: change.target.checked ? [...draft.allowedChannels, channel] : draft.allowedChannels.filter((value) => value !== channel) })} />{CHANNEL_LABELS[channel]}</label>)}</div></fieldset>
      <p className="text-xs text-muted-foreground">User opt-ins and access checks still apply. This policy never subscribes users or grants access.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {draft.retired && <p className="text-sm text-muted-foreground">Retired. Future delivery is blocked; notification history and subscriptions are preserved.</p>}
      <div className="flex flex-wrap items-start gap-3">
      {!draft.retired && !draft.locked && <Button disabled={disabled || !draft.allowedChannels.length} type="submit">{saving ? "Saving…" : "Save event"}</Button>}
      {event.sourceId.startsWith("app:") && (draft.retired
        ? <Button type="button" variant="outline" disabled={readOnly || saving} onClick={() => void changeLifecycle("restore")}>Restore event</Button>
        : confirmRetire
          ? <div className="w-full space-y-3 rounded-md border p-3"><p role="alert" className="text-sm">Retire this event? Future delivery will stop. History is kept and you can restore it. Delivery already in progress may finish.</p><div className="flex gap-2"><Button type="button" variant="destructive" disabled={readOnly || saving} onClick={() => void changeLifecycle("retire")}>Confirm retirement</Button><Button type="button" variant="outline" disabled={saving} onClick={() => setConfirmRetire(false)}>Cancel</Button></div></div>
          : <Button type="button" variant="outline" disabled={readOnly || saving} onClick={() => setConfirmRetire(true)}>Retire event</Button>)}
      </div>
    </form>
  </details>;
}

export function NotificationEventManagement({ readOnly = false }: { readOnly?: boolean }): React.ReactElement {
  const [showRetired, setShowRetired] = useState(false);
  const [notice, setNotice] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sourceId, setSourceId] = useState("");
  const [eventId, setEventId] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const reload = useCallback(async () => { setSources(await request()); }, []);
  useEffect(() => { void reload().catch((reason: Error) => setError(reason.message)).finally(() => setLoading(false)); }, [reload]);
  const apps = sources.filter((source) => source.id.startsWith("app:"));
  const selected = sourceId || apps[0]?.id || "";
  async function register(change: FormEvent): Promise<void> {
    change.preventDefault(); setSaving(true); setError("");
    try { await request("POST", { sourceId: selected, event: { id: eventId, label, description } }); setEventId(""); setLabel(""); setDescription(""); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not register event"); }
    finally { setSaving(false); }
  }
  const saved = async (message = "Event settings saved."): Promise<void> => { await reload(); setNotice(message); };
  const editors = (source?: Source) => <div className="space-y-3">{source?.events.filter((event) => showRetired || !event.retired).map((event) => <EventEditor key={`${event.sourceId}:${event.eventType}:${event.revision}`} event={event} readOnly={readOnly} onSaved={saved} />)}{source && !source.events.length && <p className="text-sm text-muted-foreground">No event types registered for this app.</p>}</div>;
  return <section className="space-y-4">
    <div><h2 className="text-xl font-semibold">Notification events</h2><p className="text-sm text-muted-foreground">Manage platform policies and installed-app event registrations. Personal subscriptions are in Settings → Notifications.</p></div>
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {loading ? <p role="status">Loading event registrations…</p> : <Tabs defaultValue="platform">
      <TabsList><TabsTrigger value="platform">Platform events</TabsTrigger><TabsTrigger value="apps">App events</TabsTrigger></TabsList>
      <TabsContent value="platform" className="space-y-4"><p className="text-sm text-muted-foreground">Event IDs and publisher bindings come from the implementation. Built-in security restrictions cannot be broadened.</p>{editors(sources.find((source) => source.id === "platform"))}</TabsContent>
      <TabsContent value="apps" className="space-y-4">
        {apps.length ? <><label className="block text-sm">Installed app<Select value={selected} onChange={(change) => setSourceId(change.target.value)}>{apps.map((app) => <option key={app.id} value={app.id}>{app.label}</option>)}</Select></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showRetired} onChange={(change) => setShowRetired(change.target.checked)} />Show retired events</label>
          {editors(apps.find((app) => app.id === selected))}
          <form onSubmit={(change) => void register(change)} className="space-y-3 rounded-lg border p-4"><h3 className="font-medium">Register an app event</h3><p className="text-sm text-muted-foreground">The app needs a bound notification publisher. Registering a type does not implement its trigger or subscribe users.</p>
            <label className="block text-sm">Event ID<Input required pattern={"[a-z][a-z0-9_.\\-]{0,63}"} maxLength={64} value={eventId} disabled={readOnly || saving} onChange={(change) => setEventId(change.target.value)} placeholder="report.ready" /></label>
            <label className="block text-sm">Event label<Input required maxLength={100} value={label} disabled={readOnly || saving} onChange={(change) => setLabel(change.target.value)} /></label>
            <label className="block text-sm">Event description<Input maxLength={300} value={description} disabled={readOnly || saving} onChange={(change) => setDescription(change.target.value)} /></label>
            <Button type="submit" disabled={readOnly || saving}>{saving ? "Registering…" : "Register event"}</Button>
          </form></> : <p className="text-sm text-muted-foreground">No enabled apps are installed.</p>}
      </TabsContent>
    </Tabs>}
  </section>;
}
