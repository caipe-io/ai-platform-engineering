"use client";

import { SettingsSwitch } from "@/components/settings/shared/SettingsSwitch";
import { cn } from "@/lib/utils";
import { BellRing, Loader2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

export type NotificationArea = "workflow" | "ingestion" | "agent";

// The events a page-level toggle controls. These are the completion and
// failure style events people care about on that page. Started events are
// left to the full settings page. Writes go to the same stored preference as
// Settings, so the two always agree.
const AREA_EVENTS: Record<NotificationArea, { events: string[]; label: string; description: string }> = {
  workflow: {
    events: ["workflow.completed", "workflow.failed", "workflow.requires_input"],
    label: "Notify me about workflows",
    description: "When your workflow runs finish, fail, or need your input.",
  },
  ingestion: {
    events: ["ingestion.completed", "ingestion.failed"],
    label: "Notify me about ingestion",
    description: "When a source you touched finishes or fails to ingest.",
  },
  agent: {
    events: ["agent.completed", "agent.failed"],
    label: "Notify me about agent runs",
    description: "When your agent tasks and longer chat runs finish or fail.",
  },
};

interface EventRow {
  type: string;
  enabled: boolean;
}

interface Props {
  area: NotificationArea;
  className?: string;
}

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

export function AreaNotificationToggle({ area, className }: Props): React.ReactElement {
  const copy = AREA_EVENTS[area];
  const [rows, setRows] = useState<EventRow[] | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // Serialize writes so a slow response cannot overwrite a newer choice.
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const apply = useCallback((data: unknown): boolean => {
    const events = (data as { events?: EventRow[] } | null)?.events;
    if (!Array.isArray(events)) return false;
    setRows(events);
    return true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/notification-preferences")
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error(body.error || "Could not load notification settings");
        if (!cancelled && !apply(body.data)) throw new Error("Unexpected response");
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setStatus({
            kind: "error",
            message: reason instanceof Error ? reason.message : "Could not load notification settings",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const enabled = rows !== null && copy.events.every((type) => rows.find((row) => row.type === type)?.enabled === true);

  const change = (value: boolean): void => {
    setStatus({ kind: "saving" });
    const patch = { events: Object.fromEntries(copy.events.map((type) => [type, value])) };
    queueRef.current = queueRef.current.then(async () => {
      try {
        const response = await fetch("/api/settings/notification-preferences", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error(body.error || "Could not save this change");
        if (!apply(body.data)) throw new Error("Unexpected response");
        setStatus({ kind: "saved" });
      } catch (reason: unknown) {
        setStatus({
          kind: "error",
          message: reason instanceof Error ? reason.message : "Could not save this change",
        });
      }
    });
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-sm", className)} data-testid={`area-notification-${area}`}>
      <BellRing aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="font-medium" title={copy.description}>{copy.label}</span>
      {rows === null && status.kind !== "error" ? (
        <Loader2 aria-label="Loading" className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <SettingsSwitch
          checked={enabled}
          disabled={rows === null || status.kind === "saving"}
          label={copy.label}
          onCheckedChange={change}
          testId={`area-notification-${area}-toggle`}
        />
      )}
      <span aria-live="polite" className={cn("text-xs", status.kind === "error" ? "text-destructive" : "text-muted-foreground")} role="status">
        {status.kind === "saving" ? "Saving…" : null}
        {status.kind === "saved" ? "Saved" : null}
        {status.kind === "error" ? status.message : null}
      </span>
      <Link
        className="rounded-sm text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        href="/settings/notifications"
      >
        All notification settings
      </Link>
    </div>
  );
}
