"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { NotificationPreferenceSwitch } from "@/components/notifications/NotificationPreferenceSwitch";
import {
  isPaused,
  type NotificationSourceView,
} from "@/lib/notifications/channels";

export function NotificationInboxSubscriptions() {
  const [sources, setSources] = useState<NotificationSourceView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function load() {
    const response = await fetch("/api/notifications/subscriptions", {
      cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok || !result.success)
      throw new Error(result.error || "Could not load subscriptions");
    setSources(result.data.sources);
  }
  useEffect(() => {
    void load().catch((reason) => setError(reason.message));
  }, []);
  async function update(sourceId: string, patch: Record<string, unknown>) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/notifications/subscriptions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, ...patch }),
      });
      const result = await response.json();
      if (!response.ok || !result.success)
        throw new Error(result.error || "Could not update subscription");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not update subscription",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-3 p-4">
      <p className="text-xs text-muted-foreground">
        Subscribe to apps and pause updates here. Followed resources and
        delivery channels are available in notification settings.
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {sources.map((source) => (
        <div key={source.id} className="space-y-2 rounded-lg border p-3">
          <NotificationPreferenceSwitch
            label={source.label}
            checked={source.subscription.enabled !== false}
            disabled={saving}
            onCheckedChange={(enabled) => void update(source.id, { enabled })}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() =>
              void update(source.id, {
                pausedUntil: isPaused(source.subscription)
                  ? null
                  : new Date(Date.now() + 3600_000).toISOString(),
              })
            }
          >
            {isPaused(source.subscription) ? "Resume" : "Pause for 1 hour"}
          </Button>
        </div>
      ))}
      <Link
        className="text-xs text-primary underline"
        href="/settings/notifications"
      >
        Manage notification settings
      </Link>
    </div>
  );
}
