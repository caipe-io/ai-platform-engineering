"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bell, Pause, Play, Send } from "lucide-react";

import { NotificationPreferenceSwitch } from "@/components/notifications/NotificationPreferenceSwitch";
import { SettingsCard } from "@/components/settings/shared/SettingsCard";
import { SettingsSwitch } from "@/components/settings/shared/SettingsSwitch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_NOTIFICATION_CHANNELS,
  NOTIFICATION_CHANNELS,
  isPaused,
  type ChannelChoices,
  type NotificationChannel,
  type NotificationSourceView,
  type NotificationSubscription,
} from "@/lib/notifications/channels";

const LABELS: Record<NotificationChannel, string> = {
  in_app: "In-app inbox",
  web_push: "Browser web push",
  webex: "Webex",
  slack: "Slack",
};
export type NotificationSettingsTab = "delivery" | "apps" | "platform" | "status";
interface DeliveryView {
  global: NotificationSubscription;
  sources: NotificationSourceView[];
  webPushPublicKey: string | null;
}

async function jsonRequest(path: string, body?: unknown, method = "PATCH") {
  const response = await fetch(
    path,
    body === undefined
      ? { cache: "no-store" }
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok || !result.success)
    throw new Error(result.error || "Could not update notifications");
  return result.data;
}

export function NotificationDeliverySettings({
  section = "all",
  chimeOption,
  expandedSections,
  onSectionChange,
  onSectionsLoaded,
}: {
  section?: NotificationSettingsTab | "all";
  chimeOption?: ReactNode;
  expandedSections?: ReadonlySet<string>;
  onSectionChange?: (id: string, expanded: boolean) => void;
  onSectionsLoaded?: (ids: string[]) => void;
} = {}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const expanded = (id: string) =>
    expandedSections ? expandedSections.has(id) : !collapsed.has(id);
  const changeSection = (id: string, open: boolean) => {
    if (onSectionChange) onSectionChange(id, open);
    else
      setCollapsed((current) => {
        const next = new Set(current);
        if (open) next.delete(id);
        else next.add(id);
        return next;
      });
  };
  const [view, setView] = useState<DeliveryView | null>(null);
  const [available, setAvailable] = useState<ChannelChoices>({ in_app: true });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const [browserReady, setBrowserReady] = useState(false);
  const [browserSubscribed, setBrowserSubscribed] = useState(false);
  const [quiet, setQuiet] = useState({
    enabled: false,
    start: "22:00",
    end: "07:00",
    timeZone: "UTC",
  });
  const [deliveries, setDeliveries] = useState<
    Array<{
      id: string;
      sourceLabel: string;
      eventType: string;
      channel: NotificationChannel;
      status: string;
      attempts: number;
      lastError?: string;
      browserDisplayedAt?: string;
    }>
  >([]);
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);
  const [deliveriesLoaded, setDeliveriesLoaded] = useState(false);

  const refreshDeliveries = useCallback(async () => {
    setLoadingDeliveries(true);
    setError(null);
    try {
      const result = await jsonRequest("/api/notifications/deliveries");
      if (!Array.isArray(result?.deliveries)) throw new Error("Unexpected delivery status response");
      setDeliveries(result.deliveries);
      setDeliveriesLoaded(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load delivery status");
    } finally {
      setLoadingDeliveries(false);
    }
  }, []);

  useEffect(() => {
    if (section === "status") void refreshDeliveries();
  }, [section, refreshDeliveries]);

  const sourceIds = view?.sources.map((source) => source.id).join(",") ?? "";
  useEffect(() => {
    onSectionsLoaded?.([
        "delivery:channels",
        "delivery:status",
        ...sourceIds.split(",").filter(Boolean).map((id) => `delivery:${id}`),
      ]);
  }, [sourceIds, onSectionsLoaded]);

  const load = useCallback(async () => {
    const result = (await jsonRequest(
      "/api/notifications/subscriptions",
    )) as DeliveryView;
    if (!result || !result.global || !Array.isArray(result.sources))
      throw new Error("Unexpected notification settings response");
    setView(result);
    if (result.global.quietHours) setQuiet(result.global.quietHours);
  }, []);

  useEffect(() => {
    void load().catch((reason) => setError(reason.message));
    void jsonRequest("/api/notifications/channels")
      .then(setAvailable)
      .catch(() => undefined);
    setQuiet((current) => ({
      ...current,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }));
    if (
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
    ) {
      void navigator.serviceWorker
        .register("/caipe-notification-sw.js", { scope: "/" })
        .then(() => navigator.serviceWorker.ready)
        .then(async (worker) => {
          registration.current = worker;
          setBrowserReady(true);
          const subscription = await worker.pushManager.getSubscription();
          if (subscription) {
            // Renew the device lease without asking for permission again.
            await jsonRequest(
              "/api/notifications/push-subscriptions",
              subscription.toJSON(),
              "POST",
            );
            setBrowserSubscribed(true);
          }
        })
        .catch((reason) =>
          console.warn(
            "[notification-settings] Browser subscription renewal failed",
            reason instanceof Error ? reason.message : "unknown",
          ),
        );
    }
  }, [load]);

  async function save(patch: Record<string, unknown>) {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await jsonRequest("/api/notifications/subscriptions", patch);
      await load();
      setMessage("Notification preferences saved.");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not save notification preferences",
      );
    } finally {
      setSaving(false);
    }
  }

  async function updateBrowser(enabled: boolean) {
    const worker = registration.current;
    if (!worker || !view?.webPushPublicKey)
      throw new Error("Web push is unavailable in this browser or deployment");
    if (enabled) {
      const key = Uint8Array.from(
        atob(view.webPushPublicKey.replace(/-/g, "+").replace(/_/g, "/")),
        (value) => value.charCodeAt(0),
      );
      const subscription = await worker.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      await jsonRequest(
        "/api/notifications/push-subscriptions",
        subscription.toJSON(),
        "POST",
      );
    } else {
      const subscription = await worker.pushManager.getSubscription();
      if (subscription) {
        await jsonRequest(
          "/api/notifications/push-subscriptions",
          { endpoint: subscription.endpoint },
          "DELETE",
        );
        await subscription.unsubscribe();
      }
    }
    setBrowserSubscribed(enabled);
  }

  async function toggleBrowser() {
    setSaving(true);
    setError(null);
    try {
      await updateBrowser(!browserSubscribed);
      setMessage(
        browserSubscribed
          ? "This browser is unsubscribed."
          : "This browser is subscribed. Enable Browser web push to receive alerts.",
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not update this browser",
      );
    } finally {
      setSaving(false);
    }
  }

  async function toggleChannel(channel: NotificationChannel, enabled: boolean) {
    setError(null);
    if (channel === "web_push" && enabled && !browserSubscribed) {
      setSaving(true);
      try {
        // Called directly from the user's toggle so the browser may request permission.
        await updateBrowser(true);
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not update browser push",
        );
        return;
      } finally {
        setSaving(false);
      }
    }
    await save({ channels: { [channel]: enabled } });
  }

  async function test(channel: NotificationChannel) {
    setError(null);
    setMessage(null);
    try {
      await jsonRequest("/api/notifications/test", { channel }, "POST");
      setMessage(
        `Test queued for ${LABELS[channel]}. Check the Delivery status tab.`,
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not send test",
      );
    }
  }

  if (!view && section !== "status")
    return (
      <div className="space-y-4">
      <p role="status" className="text-sm text-muted-foreground">
        {error ?? "Loading notification delivery…"}
      </p>
      {(section === "all" || section === "delivery") && expanded("delivery:channels") && chimeOption}
      </div>
    );
  const globallyPaused = isPaused(view?.global ?? null);
  const channels = {
    ...DEFAULT_NOTIFICATION_CHANNELS,
    ...view?.global.channels,
  };
  const sources = (view?.sources ?? []).filter((source) => section === "all" ||
    (section === "platform" && source.id === "platform") ||
    (section === "apps" && source.id.startsWith("app:")));
  return (
    <div className="space-y-6">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
      {view && (section === "all" || section === "delivery") && <SettingsCard
        collapsibleLabel="Notification delivery"
        expanded={expanded("delivery:channels")}
        onExpandedChange={(open) => changeSection("delivery:channels", open)}
        title={
          <span className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            Notification delivery
          </span>
        }
        description="Choose where updates arrive. External channels are off until you enable them."
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm">
              {globallyPaused
                ? "All notifications are paused."
                : "Notifications are active."}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() =>
                void save({
                  pausedUntil: globallyPaused
                    ? null
                    : new Date(Date.now() + 3600_000).toISOString(),
                })
              }
            >
              {globallyPaused ? (
                <Play className="mr-2 h-4 w-4" />
              ) : (
                <Pause className="mr-2 h-4 w-4" />
              )}
              {globallyPaused ? "Resume" : "Pause for 1 hour"}
            </Button>
          </div>
          {NOTIFICATION_CHANNELS.map((channel) => (
            <div
              key={channel}
              className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{LABELS[channel]}</p>
                <p className="text-xs text-muted-foreground">
                  {channel === "web_push"
                    ? "Receive a private alert on subscribed browsers, including when the page is closed."
                    : channel === "slack" || channel === "webex"
                      ? available[channel]
                        ? "Messages go to your linked account."
                        : "Requires an enabled bot and a linked account in Account & access."
                      : "Read updates in the notification bell."}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={!channels[channel] || !available[channel]}
                onClick={() => void test(channel)}
              >
                <Send className="mr-1 h-3 w-3" />
                Test
              </Button>
              <SettingsSwitch
                label={`Enable ${LABELS[channel]}`}
                checked={channels[channel]}
                disabled={
                  saving ||
                  !available[channel] ||
                  (channel === "web_push" && !browserReady)
                }
                onCheckedChange={(enabled) =>
                  void toggleChannel(channel, enabled)
                }
              />
            </div>
          ))}
          {chimeOption}
          {view.webPushPublicKey && (
            <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <p className="text-sm">
                {browserSubscribed
                  ? "This browser is subscribed."
                  : "This browser is not subscribed."}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={saving || !browserReady}
                onClick={() => void toggleBrowser()}
              >
                {browserSubscribed
                  ? "Unsubscribe this browser"
                  : "Subscribe this browser"}
              </Button>
            </div>
          )}
          <div className="space-y-3 rounded-lg border p-3">
            <NotificationPreferenceSwitch
              label="Quiet hours for external channels"
              checked={quiet.enabled}
              disabled={saving}
              onCheckedChange={(enabled) =>
                setQuiet((current) => ({ ...current, enabled }))
              }
            />
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs">
                From
                <Input
                  aria-label="Quiet hours start"
                  type="time"
                  value={quiet.start}
                  onChange={(event) =>
                    setQuiet({ ...quiet, start: event.target.value })
                  }
                />
              </label>
              <label className="text-xs">
                To
                <Input
                  aria-label="Quiet hours end"
                  type="time"
                  value={quiet.end}
                  onChange={(event) =>
                    setQuiet({ ...quiet, end: event.target.value })
                  }
                />
              </label>
              <label className="text-xs">
                Time zone
                <Input
                  aria-label="Quiet hours time zone"
                  value={quiet.timeZone}
                  onChange={(event) =>
                    setQuiet({ ...quiet, timeZone: event.target.value })
                  }
                />
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => void save({ quietHours: quiet })}
              >
                Save quiet hours
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Web push, Webex, and Slack wait until quiet hours end. Your inbox
              continues to collect updates.
            </p>
          </div>
        </div>
      </SettingsCard>}
      {section === "apps" && sources.length === 0 && <p className="text-sm text-muted-foreground">No apps have registered notifications yet.</p>}
      {sources.map((source) => (
        <SettingsCard
          key={source.id}
          title={source.label}
          collapsibleLabel={source.label}
          expanded={expanded(`delivery:${source.id}`)}
          onExpandedChange={(open) =>
            changeSection(`delivery:${source.id}`, open)
          }
          description={
            source.id === "platform"
              ? "Workflow, ingestion, agent, and platform updates."
              : "Updates published by this installed app."
          }
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <NotificationPreferenceSwitch
                label={`Subscribe to ${source.label}`}
                visibleLabel={`Send me ${source.label} notifications`}
                checked={source.subscription.enabled !== false}
                disabled={saving}
                onCheckedChange={(enabled) =>
                  void save({ sourceId: source.id, enabled })
                }
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() =>
                  void save({
                    sourceId: source.id,
                    pausedUntil: isPaused(source.subscription)
                      ? null
                      : new Date(Date.now() + 3600_000).toISOString(),
                  })
                }
              >
                {isPaused(source.subscription)
                  ? "Resume notifications"
                  : "Pause for 1 hour"}
              </Button>
            </div>
            <p className="text-sm font-medium">What to send</p>
            <div className="grid gap-2 md:grid-cols-2">
              {source.events.map((event) => (
                <div key={event.id} className="space-y-2 rounded-lg border p-3">
                  <NotificationPreferenceSwitch
                    label={event.label}
                    checked={event.subscription.enabled !== false}
                    disabled={saving || source.subscription.enabled === false}
                    onCheckedChange={(enabled) =>
                      void save({
                        sourceId: source.id,
                        eventType: event.id,
                        enabled,
                      })
                    }
                  />
                  {event.description && (
                    <p className="text-xs text-muted-foreground">
                      {event.description}
                    </p>
                  )}
                  <details>
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      Delivery channels
                    </summary>
                    <div className="mt-2 flex flex-wrap gap-3">
                      {NOTIFICATION_CHANNELS.map((channel) => (
                        <label
                          key={channel}
                          className="flex items-center gap-1 text-xs"
                        >
                          <input
                            type="checkbox"
                            aria-label={`${event.label}: ${LABELS[channel]}`}
                            checked={
                              channels[channel] &&
                              (event.subscription.channels?.[channel] ??
                                source.subscription.channels?.[channel] ??
                                true)
                            }
                            disabled={saving || !channels[channel]}
                            onChange={(change) =>
                              void save({
                                sourceId: source.id,
                                eventType: event.id,
                                channels: { [channel]: change.target.checked },
                              })
                            }
                          />
                          {LABELS[channel]}
                        </label>
                      ))}
                    </div>
                  </details>
                </div>
              ))}
            </div>
            {source.id.startsWith("app:") && (
              <div>
                <p className="text-sm font-medium">What you follow</p>
                <a
                  className="text-sm text-primary underline"
                  href={`/apps/${encodeURIComponent(source.id.slice(4))}`}
                >
                  Manage followed resources in {source.label}
                </a>
              </div>
            )}
            <p className="text-sm font-medium">Where to send</p>
            <div className="flex flex-wrap gap-4">
              {NOTIFICATION_CHANNELS.map((channel) => (
                <label
                  key={channel}
                  className="flex items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    aria-label={`${source.label}: ${LABELS[channel]}`}
                    checked={
                      channels[channel] &&
                      (source.subscription.channels?.[channel] ?? true)
                    }
                    disabled={
                      saving ||
                      !channels[channel] ||
                      source.subscription.enabled === false
                    }
                    onChange={(change) =>
                      void save({
                        sourceId: source.id,
                        channels: { [channel]: change.target.checked },
                      })
                    }
                  />
                  {LABELS[channel]}
                </label>
              ))}
            </div>
          </div>
        </SettingsCard>
      ))}
      {(section === "all" || section === "status") && <SettingsCard
        title="Delivery status"
        collapsibleLabel="Delivery status"
        expanded={expanded("delivery:status")}
        onExpandedChange={(open) => changeSection("delivery:status", open)}
        description="Each channel retries independently. Provider acceptance does not confirm that a person read the notification."
      >
        <Button
          size="sm"
          variant="outline"
          disabled={loadingDeliveries}
          onClick={() => void refreshDeliveries()}
        >
          {loadingDeliveries ? "Refreshing delivery status…" : "Refresh delivery status"}
        </Button>
        {deliveriesLoaded && deliveries.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No recent deliveries.</p>}
        <ul className="mt-3 space-y-2">
          {deliveries.map((delivery) => (
            <li
              key={delivery.id}
              className="flex items-center gap-3 border-b py-2 text-xs"
            >
              <span className="flex-1">
                {delivery.sourceLabel} · {delivery.eventType} ·{" "}
                {LABELS[delivery.channel]}
                <span className="block text-muted-foreground">
                  {delivery.status} · {delivery.attempts} attempts
                  {delivery.browserDisplayedAt ? " · Shown by browser" : ""}
                  {delivery.channel === "web_push" &&
                  delivery.status === "delivered" &&
                  !delivery.browserDisplayedAt
                    ? " · Browser display not confirmed"
                    : ""}
                  {delivery.lastError ? ` · ${delivery.lastError}` : ""}
                </span>
              </span>
              {delivery.status === "failed" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void jsonRequest(
                      `/api/notifications/deliveries/${delivery.id}/retry`,
                      {},
                      "POST",
                    )
                      .then(refreshDeliveries)
                      .catch((reason) => setError(reason.message));
                  }}
                >
                  Retry
                </Button>
              )}
            </li>
          ))}
        </ul>
      </SettingsCard>}
    </div>
  );
}
