"use client";

import { SettingsCard } from "@/components/settings/shared/SettingsCard";
import { SettingsSwitch } from "@/components/settings/shared/SettingsSwitch";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Loader2, RotateCcw, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type CategoryId = "ingestion" | "workflow" | "agent" | "platform";
type EventType =
  | "ingestion.completed"
  | "ingestion.failed"
  | "ingestion.started"
  | "workflow.completed"
  | "workflow.failed"
  | "workflow.requires_input"
  | "workflow.started"
  | "agent.completed"
  | "agent.failed"
  | "agent.started"
  | "service.degraded"
  | "service.recovered";

interface EventRow {
  type: EventType;
  category: CategoryId;
  enabled: boolean;
  explicit: boolean;
}

interface EffectiveView {
  categories: CategoryId[];
  events: EventRow[];
  preferences: {
    categories?: Partial<Record<CategoryId, boolean>>;
    events?: Partial<Record<EventType, boolean>>;
  };
}

interface Patch {
  categories?: Partial<Record<CategoryId, boolean | null>>;
  events?: Partial<Record<EventType, boolean | null>>;
}

// Display copy lives here so the server catalog stays free of UI wording.
const CATEGORY_COPY: Record<CategoryId, { title: string; description: string }> = {
  ingestion: {
    title: "Knowledge ingestion",
    description: "Sources you add to a knowledge base.",
  },
  workflow: {
    title: "Workflows",
    description: "Workflow runs you start or own.",
  },
  agent: {
    title: "Agent tasks",
    description: "Scheduled and background agent tasks you own.",
  },
  platform: {
    title: "Platform",
    description: "Service health changes that affect the platform.",
  },
};

const EVENT_COPY: Record<EventType, { label: string; description: string }> = {
  "ingestion.completed": { label: "Ingestion finished", description: "A source finished indexing." },
  "ingestion.failed": { label: "Ingestion failed", description: "A source could not be indexed." },
  "ingestion.started": { label: "Ingestion started", description: "A source began indexing." },
  "workflow.completed": { label: "Workflow completed", description: "A workflow run finished successfully." },
  "workflow.failed": { label: "Workflow failed", description: "A workflow run stopped with an error." },
  "workflow.requires_input": { label: "Workflow needs input", description: "A workflow is waiting for your answer." },
  "workflow.started": { label: "Workflow started", description: "A workflow run began." },
  "agent.completed": { label: "Agent task completed", description: "A background agent task finished." },
  "agent.failed": { label: "Agent task failed", description: "A background agent task failed." },
  "agent.started": { label: "Agent task started", description: "A background agent task began." },
  "service.degraded": { label: "Service degraded", description: "A service is no longer healthy." },
  "service.recovered": { label: "Service recovered", description: "A degraded service is healthy again." },
};

function isEffectiveView(value: unknown): value is EffectiveView {
  const candidate = value as Partial<EffectiveView> | null;
  return Boolean(candidate && Array.isArray(candidate.events) && Array.isArray(candidate.categories));
}

const CATEGORY_ORDER: CategoryId[] = ["workflow", "ingestion", "agent", "platform"];

interface SaveState {
  status: "idle" | "saving" | "saved" | "error";
  message?: string;
}

export function EventNotificationSettings(): React.ReactElement {
  const [view, setView] = useState<EffectiveView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [pendingPatch, setPendingPatch] = useState<Patch | null>(null);
  const [testResults, setTestResults] = useState<Partial<Record<EventType, { error: boolean; text: string }>>>({});
  const [testing, setTesting] = useState<EventType | null>(null);
  // Serialize writes so responses cannot arrive out of order and overwrite
  // a newer choice with an older one.
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const applyResponse = useCallback((next: EffectiveView) => {
    setView(next);
    setLoadError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/notification-preferences")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || "Could not load event notification settings");
        }
        if (cancelled) return;
        if (!isEffectiveView(data.data)) {
          throw new Error("Unexpected response from the notification settings API");
        }
        applyResponse(data.data);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setLoadError(reason instanceof Error ? reason.message : "Could not load event notification settings");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applyResponse]);

  const send = useCallback(
    (patch: Patch) => {
      setSave({ status: "saving" });
      setPendingPatch(null);
      const request = queueRef.current.then(async () => {
        try {
          const response = await fetch("/api/settings/notification-preferences", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          });
          const data = await response.json();
          if (!response.ok || !data.success) {
            throw new Error(data.error || "Could not save this change");
          }
          if (!isEffectiveView(data.data)) {
            throw new Error("Unexpected response from the notification settings API");
          }
          applyResponse(data.data);
          setSave({ status: "saved" });
        } catch (reason: unknown) {
          setPendingPatch(patch);
          setSave({
            status: "error",
            message: reason instanceof Error ? reason.message : "Could not save this change",
          });
        }
      });
      queueRef.current = request;
    },
    [applyResponse],
  );

  // Sends the signed-in user one sample notification through the real publish
  // path, so a turned-off event is skipped exactly as it would be for a real one.
  const sendTest = async (type: EventType): Promise<void> => {
    setTesting(type);
    setTestResults((current) => ({ ...current, [type]: undefined }));
    try {
      const response = await fetch("/api/settings/notification-preferences/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Could not send the test notification");
      const skipped = data.data?.outcome === "disabled";
      setTestResults((current) => ({
        ...current,
        [type]: {
          error: false,
          text: skipped
            ? "Skipped, because this event is turned off for you."
            : "Sent. It appears in your notification bell.",
        },
      }));
      if (!skipped) window.dispatchEvent(new CustomEvent("in-app-notifications:refresh"));
    } catch (reason: unknown) {
      setTestResults((current) => ({
        ...current,
        [type]: { error: true, text: reason instanceof Error ? reason.message : "Could not send the test notification" },
      }));
    } finally {
      setTesting(null);
    }
  };

  const setEvent = (type: EventType, value: boolean | null): void => {
    send({ events: { [type]: value } });
  };

  // Applies to every event in the category and clears per-event choices, so
  // the category switch is never overridden by a stale event setting.
  const setCategory = (category: CategoryId, value: boolean): void => {
    if (!view) return;
    const events: Partial<Record<EventType, boolean | null>> = {};
    for (const row of view.events) {
      if (row.category === category && row.explicit) events[row.type] = null;
    }
    send({ categories: { [category]: value }, events });
  };

  if (loadError && !view) {
    return (
      <SettingsCard
        description="Choose which events notify you."
        title={<span className="flex items-center gap-2"><Zap className="h-5 w-5 text-primary" />Event notifications</span>}
      >
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {loadError}
        </div>
      </SettingsCard>
    );
  }

  if (!view) {
    return (
      <SettingsCard
        description="Choose which events notify you."
        title={<span className="flex items-center gap-2"><Zap className="h-5 w-5 text-primary" />Event notifications</span>}
      >
        <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading event notification settings…
        </div>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard
      description="Choose which events notify you. Each setting applies only to your account. Changes save as you make them."
      title={<span className="flex items-center gap-2"><Zap className="h-5 w-5 text-primary" />Event notifications</span>}
    >
      <div className="space-y-6">
        {save.status !== "idle" ? (
          <div aria-live="polite" className="flex min-h-5 items-center gap-2 text-xs text-muted-foreground" role="status">
            {save.status === "saving" ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" />Saving…</>
            ) : null}
            {save.status === "saved" ? "All changes saved." : null}
            {save.status === "error" ? (
              <span className="flex flex-wrap items-center gap-2 text-destructive">
                {save.message}
                {pendingPatch ? (
                  <Button onClick={() => send(pendingPatch)} size="sm" type="button" variant="secondary">
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" />Retry
                  </Button>
                ) : null}
              </span>
            ) : null}
          </div>
        ) : null}

        {CATEGORY_ORDER.map((category) => {
          const rows = view.events.filter((row) => row.category === category);
          if (rows.length === 0) return null;
          const copy = CATEGORY_COPY[category];
          const allOn = rows.every((row) => row.enabled);
          const categoryExplicit = view.preferences.categories?.[category] !== undefined;
          return (
            <section aria-labelledby={`events-${category}`} className="space-y-3" key={category}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold" id={`events-${category}`}>{copy.title}</h3>
                  <p className="text-xs text-muted-foreground">
                    {copy.description}
                    {!categoryExplicit ? " Using defaults." : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {rows.filter((row) => row.enabled).length} of {rows.length} on
                  </span>
                  <SettingsSwitch
                  checked={allOn}
                  label={`${copy.title}: all events`}
                  onCheckedChange={(value) => setCategory(category, value)}
                  testId={`event-category-${category}-toggle`}
                />
                </div>
              </div>

              <ul className="divide-y divide-border/70 rounded-lg border border-border/70">
                {rows.map((row) => {
                  const event = EVENT_COPY[row.type];
                  return (
                    <li className="flex flex-wrap items-center gap-3 p-3 sm:flex-nowrap sm:gap-4 sm:p-4" key={row.type}>
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {event.label}
                          {!row.explicit ? (
                            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
                              Default
                            </span>
                          ) : null}
                        </p>
                        <p className="text-xs text-muted-foreground">{event.description}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-3">
                          <button
                            className={cn(
                              "text-xs text-primary underline-offset-4 hover:underline disabled:opacity-50",
                              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm",
                            )}
                            disabled={testing !== null}
                            onClick={() => { void sendTest(row.type); }}
                            type="button"
                          >
                            {testing === row.type ? "Sending…" : "Send test"}
                          </button>
                          {row.explicit ? (
                            <button
                              className={cn(
                                "text-xs text-primary underline-offset-4 hover:underline",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm",
                              )}
                              onClick={() => setEvent(row.type, null)}
                              type="button"
                            >
                              Reset to default
                            </button>
                          ) : null}
                        </div>
                        {testResults[row.type] ? (
                          <p
                            aria-live="polite"
                            className={cn("mt-1 text-xs", testResults[row.type]?.error ? "text-destructive" : "text-muted-foreground")}
                            role={testResults[row.type]?.error ? "alert" : "status"}
                          >
                            {testResults[row.type]?.text}
                          </p>
                        ) : null}
                      </div>
                      <SettingsSwitch
                        checked={row.enabled}
                        label={event.label}
                        onCheckedChange={(value) => setEvent(row.type, value)}
                        testId={`event-toggle-${row.type}`}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}

      </div>
    </SettingsCard>
  );
}
