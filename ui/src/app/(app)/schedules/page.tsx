"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { formatDistance } from "date-fns";
import {
  AlertTriangle,
  Bot,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Clock3,
  History,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { AuthGuard } from "@/components/auth-guard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { humanizeCron } from "@/lib/cron-humanize";
import { getConfig } from "@/lib/config";
import { pushWithNavigationProgress } from "@/lib/navigation-progress";
import { resolveUsableChatAgentId } from "@/lib/chat-agent-selection";
import { useChatStore } from "@/store/chat-store";
import { useRouter } from "next/navigation";

interface ScheduleRun {
  ts: string | null;
  status: "ok" | "error" | null;
  error: string | null;
  http_status: number | null;
}

type OneOffRunStatus =
  | "pending"
  | "claimed"
  | "fired"
  | "succeeded"
  | "failed"
  | "cancelled";

interface ScheduleOneOffRun {
  one_off_run_id: string;
  schedule_id: string;
  run_at: string | null;
  status: OneOffRunStatus;
  message_template: string | null;
  reason: string | null;
  retry_num: number | null;
  retry_limit: number | null;
  job_name: string | null;
  error: string | null;
  http_status: number | null;
  created_at: string | null;
  updated_at: string | null;
  claimed_at: string | null;
  fired_at: string | null;
  completed_at: string | null;
}

interface ScheduleVersion {
  version: number;
  superseded_at: string | null;
  changed_fields: string[];
  title: string | null;
  agent_id: string;
  edit_agent_id: string | null;
  message_template: string;
  attributes: Record<string, unknown>;
  cron: string;
  tz: string;
  enabled: boolean;
  cronjob_name: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface ScheduleEventChange {
  before?: unknown;
  after?: unknown;
}

interface ScheduleEvent {
  event_id: string;
  event_type: string;
  occurred_at: string | null;
  actor_type: "user" | "admin" | "system";
  actor_id: string;
  source: string;
  changed_fields: string[];
  changes: Record<string, ScheduleEventChange>;
}

type ScheduleHistoryEntry =
  | { kind: "version"; occurredAt: string | null; version: ScheduleVersion }
  | { kind: "event"; occurredAt: string | null; event: ScheduleEvent };

interface ScheduleItem {
  schedule_id: string;
  agent_id: string;
  edit_agent_id: string | null;
  agent_name: string;
  title: string | null;
  message_template: string;
  attributes: Record<string, unknown>;
  cron: string;
  tz: string;
  enabled: boolean;
  cronjob_name: string | null;
  version: number;
  versions: ScheduleVersion[];
  events: ScheduleEvent[];
  created_at: string | null;
  updated_at: string | null;
  last_run: ScheduleRun | null;
  one_off_runs: ScheduleOneOffRun[];
}

interface SchedulesResponse {
  success: boolean;
  data?: {
    items: ScheduleItem[];
    total: number;
    server_now?: string;
    minimum_schedule_interval_seconds?: number;
  };
  error?: string;
}

interface ScheduleMutationResponse {
  success: boolean;
  data?: ScheduleItem;
  error?: string;
}

interface ScheduleDeleteResponse {
  success: boolean;
  data?: {
    deleted: string;
  };
  error?: string;
}

interface PlatformConfigResponse {
  success?: boolean;
  data?: {
    schedule_editor_agent_id?: unknown;
  };
}

const SCHEDULES_TABLE_MIN_WIDTH = 1160;
const DEFAULT_MINIMUM_SCHEDULE_INTERVAL_SECONDS = 30 * 60;

function formatScheduleInterval(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

interface TableScrollMetrics {
  scrollWidth: number;
  canScroll: boolean;
  atStart: boolean;
  atEnd: boolean;
}

function SchedulesTableFrame({ children }: { children: ReactNode }) {
  const topScrollRef = useRef<HTMLDivElement>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<TableScrollMetrics>({
    scrollWidth: SCHEDULES_TABLE_MIN_WIDTH,
    canScroll: false,
    atStart: true,
    atEnd: true,
  });

  const updateMetrics = useCallback(() => {
    const scroller = tableScrollRef.current;
    if (!scroller) return;

    const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const nextMetrics: TableScrollMetrics = {
      scrollWidth: Math.max(scroller.scrollWidth, SCHEDULES_TABLE_MIN_WIDTH),
      canScroll: maxScrollLeft > 1,
      atStart: scroller.scrollLeft <= 1,
      atEnd: scroller.scrollLeft >= maxScrollLeft - 1,
    };

    setMetrics((current) =>
      current.scrollWidth === nextMetrics.scrollWidth &&
      current.canScroll === nextMetrics.canScroll &&
      current.atStart === nextMetrics.atStart &&
      current.atEnd === nextMetrics.atEnd
        ? current
        : nextMetrics
    );
  }, []);

  // Table content can change width without a window resize, so re-measure after render.
  useEffect(() => {
    updateMetrics();
  });

  useEffect(() => {
    const scroller = tableScrollRef.current;
    if (!scroller) return;

    const frame =
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame(updateMetrics)
        : null;
    let resizeObserver: ResizeObserver | null = null;

    if (typeof window.ResizeObserver === "function") {
      resizeObserver = new window.ResizeObserver(updateMetrics);
      resizeObserver.observe(scroller);
      if (scroller.firstElementChild) {
        resizeObserver.observe(scroller.firstElementChild);
      }
    }

    window.addEventListener("resize", updateMetrics);
    return () => {
      if (frame !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frame);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateMetrics);
    };
  }, [updateMetrics]);

  const syncScroll = useCallback(
    (source: "top" | "table") => {
      const sourceNode =
        source === "top" ? topScrollRef.current : tableScrollRef.current;
      const targetNode =
        source === "top" ? tableScrollRef.current : topScrollRef.current;

      if (!sourceNode || !targetNode) return;
      if (targetNode.scrollLeft !== sourceNode.scrollLeft) {
        targetNode.scrollLeft = sourceNode.scrollLeft;
      }
      updateMetrics();
    },
    [updateMetrics]
  );

  return (
    <div className="relative w-full min-w-0 overflow-hidden rounded-lg border bg-card">
      <div
        ref={topScrollRef}
        aria-label="Scroll scheduled jobs table horizontally"
        className={[
          "overflow-x-auto overflow-y-hidden border-b bg-muted/20 scrollbar-modern",
          metrics.canScroll ? "block" : "hidden",
        ].join(" ")}
        onScroll={() => syncScroll("top")}
      >
        <div className="h-3" style={{ width: `${metrics.scrollWidth}px` }} />
      </div>

      <div
        className={[
          "pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-gradient-to-r from-card to-transparent transition-opacity",
          metrics.canScroll && !metrics.atStart ? "opacity-100" : "opacity-0",
        ].join(" ")}
      />
      <div
        className={[
          "pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-card to-transparent transition-opacity",
          metrics.canScroll && !metrics.atEnd ? "opacity-100" : "opacity-0",
        ].join(" ")}
      />

      <div
        ref={tableScrollRef}
        className="overflow-x-auto scrollbar-modern"
        onScroll={() => syncScroll("table")}
      >
        {children}
      </div>
    </div>
  );
}

function formatDateTime(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function formatRelative(value: string | null, now: Date): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDistance(date, now, { addSuffix: true });
}

function lastRunLabel(schedule: ScheduleItem, now: Date): string {
  if (!schedule.last_run?.ts) return "Never";
  const prefix = schedule.last_run.status === "error" ? "Failed" : "Ran";
  return `${prefix} ${formatRelative(schedule.last_run.ts, now)}`;
}

const ACTIVE_ONE_OFF_STATUSES = new Set<OneOffRunStatus>([
  "pending",
  "claimed",
  "fired",
]);

function isActiveOneOff(run: ScheduleOneOffRun): boolean {
  return ACTIVE_ONE_OFF_STATUSES.has(run.status);
}

function oneOffStatusLabel(status: OneOffRunStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function oneOffStatusVariant(
  status: OneOffRunStatus
): "secondary" | "destructive" | "status" | "tool" {
  if (status === "failed") return "destructive";
  if (status === "succeeded") return "status";
  if (status === "cancelled") return "secondary";
  return "tool";
}

function oneOffTimingLabel(run: ScheduleOneOffRun, now: Date): string {
  if (run.status === "pending") {
    return run.run_at ? `Runs ${formatRelative(run.run_at, now)}` : "Run time unknown";
  }
  if (run.status === "claimed") {
    return run.claimed_at
      ? `Claimed ${formatRelative(run.claimed_at, now)}`
      : "Claimed";
  }
  if (run.status === "fired") {
    return run.fired_at
      ? `Fired ${formatRelative(run.fired_at, now)}`
      : "Fired";
  }
  return run.completed_at
    ? `Completed ${formatRelative(run.completed_at, now)}`
    : run.run_at
      ? `Scheduled ${formatRelative(run.run_at, now)}`
      : "Completed";
}

function oneOffDetailLabel(run: ScheduleOneOffRun): string {
  if (run.reason) return run.reason;
  if (run.message_template) return "Custom message override";
  return "Parent schedule message";
}

function oneOffRetryLabel(run: ScheduleOneOffRun): string | null {
  if (run.retry_num === null && run.retry_limit === null) return null;
  return `Retry ${run.retry_num ?? "?"} / ${run.retry_limit ?? "?"}`;
}

function oneOffSummaryLabel(totalCount: number, activeCount: number): string {
  if (activeCount > 0) {
    return `${activeCount} active one-off${activeCount === 1 ? "" : "s"}`;
  }
  return `${totalCount} recent one-off${totalCount === 1 ? "" : "s"}`;
}

function oneOffPanelId(scheduleId: string): string {
  return `one-off-runs-${scheduleId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function changedFieldsLabel(version: ScheduleVersion): string {
  return version.changed_fields.length > 0
    ? version.changed_fields.join(", ")
    : "settings";
}

function scheduleChangeHistory(schedule: ScheduleItem): ScheduleHistoryEntry[] {
  const entries: ScheduleHistoryEntry[] = [
    ...(schedule.versions || []).map((version) => ({
      kind: "version" as const,
      occurredAt: version.superseded_at,
      version,
    })),
    ...(schedule.events || []).map((event) => ({
      kind: "event" as const,
      occurredAt: event.occurred_at,
      event,
    })),
  ];

  return entries.sort((left, right) => {
    const leftTime = left.occurredAt ? Date.parse(left.occurredAt) : 0;
    const rightTime = right.occurredAt ? Date.parse(right.occurredAt) : 0;
    return rightTime - leftTime;
  });
}

function scheduleEventSourceLabel(source: string): string {
  if (source === "deployment_reconcile") return "New deployment";
  if (source === "operator_reconcile") return "Operator reconciliation";
  return source.replace(/[_-]+/g, " ");
}

function historyValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not set";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function scheduleTitle(schedule: ScheduleItem): string {
  return schedule.title?.trim() || schedule.agent_name || schedule.schedule_id;
}

function formatAttributeLabel(key: string): string {
  return key.replace(/[_-]+/g, " ");
}

function formatAttributeValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function scheduleAttributeEntries(schedule: ScheduleItem): [string, string][] {
  const attributes = schedule.attributes || {};

  return Object.entries(attributes)
    .map(([key, value]) => [key, formatAttributeValue(value)] as [string, string | null])
    .filter((entry): entry is [string, string] => Boolean(entry[1]));
}

async function resolveConfiguredScheduleEditorAgentId(): Promise<string | null> {
  try {
    const response = await fetch("/api/admin/platform-config", {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Failed to load platform config: ${response.status}`);
    }
    const body = (await response.json()) as PlatformConfigResponse;
    const configuredId = body.success
      ? body.data?.schedule_editor_agent_id
      : null;
    if (typeof configuredId === "string" && configuredId.trim()) {
      return configuredId.trim();
    }
  } catch (error) {
    console.warn(
      "Failed to load the scheduler editor agent; using the deployment fallback.",
      error,
    );
  }
  return getConfig("scheduleEditorAgentId")?.trim() || null;
}

export default function SchedulesPage() {
  const router = useRouter();
  const createConversation = useChatStore((state) => state.createConversation);
  const setPendingMessage = useChatStore((state) => state.setPendingMessage);
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [chattingId, setChattingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<ScheduleItem | null>(null);
  const [deleteItem, setDeleteItem] = useState<ScheduleItem | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editCron, setEditCron] = useState("");
  const [editTz, setEditTz] = useState("");
  const [editMessage, setEditMessage] = useState("");
  const [minimumScheduleIntervalSeconds, setMinimumScheduleIntervalSeconds] =
    useState(DEFAULT_MINIMUM_SCHEDULE_INTERVAL_SECONDS);
  const [clockTick, setClockTick] = useState(() => Date.now());
  const [serverClock, setServerClock] = useState<{
    serverNowMs: number;
    clientNowMs: number;
  } | null>(null);
  const [expandedOneOffIds, setExpandedOneOffIds] = useState<Set<string>>(
    () => new Set()
  );

  useEffect(() => {
    const interval = window.setInterval(() => {
      setClockTick(Date.now());
    }, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const relativeNow = useMemo(() => {
    if (!serverClock) return new Date(clockTick);
    return new Date(serverClock.serverNowMs + (clockTick - serverClock.clientNowMs));
  }, [clockTick, serverClock]);

  const editingHistory = useMemo(
    () => (editingItem ? scheduleChangeHistory(editingItem) : []),
    [editingItem]
  );

  const loadSchedules = useCallback(async () => {
    setError(null);
    setRefreshing(true);
    try {
      const clientNowMs = Date.now();
      const response = await fetch("/api/schedules", { cache: "no-store" });
      const body = (await response.json()) as SchedulesResponse;
      if (!response.ok || !body.success || !body.data) {
        throw new Error(body.error || "Failed to load schedules");
      }
      const serverNowMs = body.data.server_now
        ? Date.parse(body.data.server_now)
        : Number.NaN;
      setServerClock({
        serverNowMs: Number.isNaN(serverNowMs) ? clientNowMs : serverNowMs,
        clientNowMs,
      });
      setClockTick(Date.now());
      const configuredMinimum = body.data.minimum_schedule_interval_seconds;
      if (
        typeof configuredMinimum === "number" &&
        Number.isInteger(configuredMinimum) &&
        configuredMinimum > 0
      ) {
        setMinimumScheduleIntervalSeconds(configuredMinimum);
      }
      setItems(
        body.data.items.map((item) => ({
          ...item,
          one_off_runs: item.one_off_runs || [],
        }))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadSchedules();
  }, [loadSchedules]);

  const openEditor = useCallback((item: ScheduleItem) => {
    setEditingItem(item);
    setEditTitle(scheduleTitle(item));
    setEditCron(item.cron);
    setEditTz(item.tz);
    setEditMessage(item.message_template);
  }, []);

  const toggleOneOffRuns = useCallback((scheduleId: string) => {
    setExpandedOneOffIds((current) => {
      const next = new Set(current);
      if (next.has(scheduleId)) {
        next.delete(scheduleId);
      } else {
        next.add(scheduleId);
      }
      return next;
    });
  }, []);

  const applyUpdatedSchedule = useCallback((updated: ScheduleItem) => {
    setItems((current) =>
      current.map((currentItem) => {
        if (currentItem.schedule_id !== updated.schedule_id) return currentItem;
        return {
          ...updated,
          one_off_runs: updated.one_off_runs || currentItem.one_off_runs || [],
        };
      })
    );
    setEditingItem((current) => {
      if (current?.schedule_id !== updated.schedule_id) return current;
      return {
        ...updated,
        one_off_runs: updated.one_off_runs || current.one_off_runs || [],
      };
    });
    setEditTitle(scheduleTitle(updated));
    setEditCron(updated.cron);
    setEditTz(updated.tz);
    setEditMessage(updated.message_template);
  }, []);

  const toggleSchedule = useCallback(async (item: ScheduleItem) => {
    const nextEnabled = !item.enabled;
    const verb = nextEnabled ? "restart" : "pause";

    setError(null);
    setMutatingId(item.schedule_id);
    try {
      const response = await fetch(
        `/api/schedules/${encodeURIComponent(item.schedule_id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: nextEnabled ? "restart" : "pause" }),
        }
      );
      const body = (await response.json()) as ScheduleMutationResponse;
      if (!response.ok || !body.success || !body.data) {
        throw new Error(body.error || `Failed to ${verb} schedule`);
      }
      applyUpdatedSchedule(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutatingId(null);
    }
  }, [applyUpdatedSchedule]);

  const deleteSchedule = useCallback(async () => {
    if (!deleteItem) return;

    setError(null);
    setMutatingId(deleteItem.schedule_id);
    try {
      const response = await fetch(
        `/api/schedules/${encodeURIComponent(deleteItem.schedule_id)}`,
        { method: "DELETE" }
      );
      const body = (await response.json()) as ScheduleDeleteResponse;
      if (!response.ok || !body.success || !body.data) {
        throw new Error(body.error || "Failed to delete schedule");
      }

      setItems((current) =>
        current.filter((item) => item.schedule_id !== deleteItem.schedule_id)
      );
      setEditingItem((current) =>
        current?.schedule_id === deleteItem.schedule_id ? null : current
      );
      setDeleteItem(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutatingId(null);
    }
  }, [deleteItem]);

  const patchSchedule = useCallback(
    async (
      item: ScheduleItem,
      patch: {
        cron?: string;
        tz?: string;
        message_template?: string;
        enabled?: boolean;
        title?: string;
        attributes?: Record<string, unknown>;
        edit_agent_id?: string | null;
      },
      failureMessage: string
    ) => {
      setError(null);
      setMutatingId(item.schedule_id);
      try {
        const response = await fetch(
          `/api/schedules/${encodeURIComponent(item.schedule_id)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          }
        );
        const body = (await response.json()) as ScheduleMutationResponse;
        if (!response.ok || !body.success || !body.data) {
          throw new Error(body.error || failureMessage);
        }
        applyUpdatedSchedule(body.data);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setMutatingId(null);
      }
    },
    [applyUpdatedSchedule]
  );

  const saveEdit = useCallback(async () => {
    if (!editingItem) return;
    const saved = await patchSchedule(
      editingItem,
      {
        title: editTitle,
        cron: editCron,
        tz: editTz,
        message_template: editMessage,
      },
      "Failed to update schedule"
    );
    if (saved) {
      setEditingItem(null);
    }
  }, [editCron, editMessage, editTitle, editTz, editingItem, patchSchedule]);

  const rollbackToVersion = useCallback(
    async (version: ScheduleVersion) => {
      if (!editingItem) return;
      await patchSchedule(
        editingItem,
        {
          ...(version.title ? { title: version.title } : {}),
          edit_agent_id: version.edit_agent_id,
          attributes: version.attributes,
          cron: version.cron,
          tz: version.tz,
          message_template: version.message_template,
          enabled: version.enabled,
        },
        "Failed to roll back schedule"
      );
    },
    [editingItem, patchSchedule]
  );

  const chatWithEditorAgent = useCallback(
    async (item: ScheduleItem) => {
      setError(null);
      setChattingId(item.schedule_id);
      try {
        const configuredEditorAgentId =
          item.edit_agent_id?.trim() ||
          (await resolveConfiguredScheduleEditorAgentId());
        const scheduleEditorAgentId =
          configuredEditorAgentId ||
          (await resolveUsableChatAgentId());
        const conversationId = await createConversation(scheduleEditorAgentId);
        setPendingMessage(
          [
            "Help me modify this scheduled job.",
            "",
            `title: ${scheduleTitle(item)}`,
            `schedule_id: ${item.schedule_id}`,
            `agent_id: ${item.agent_id}`,
            `edit_agent_id: ${item.edit_agent_id || "default"}`,
            `attributes: ${JSON.stringify(item.attributes || {})}`,
            `cron: ${item.cron}`,
            `timezone: ${item.tz}`,
            `enabled: ${item.enabled}`,
            "",
            "Current message_template:",
            item.message_template,
            "",
            "Please fetch the schedule first, verify it belongs to me, then help me make the change safely.",
          ].join("\n")
        );
        pushWithNavigationProgress(router,`/chat/${conversationId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setChattingId(null);
      }
    },
    [createConversation, router, setPendingMessage]
  );

  const stats = useMemo(() => {
    const enabled = items.filter((item) => item.enabled).length;
    const failed = items.filter((item) => item.last_run?.status === "error").length;
    const activeOneOffs = items.reduce(
      (count, item) =>
        count + (item.one_off_runs || []).filter(isActiveOneOff).length,
      0
    );
    return { enabled, paused: items.length - enabled, failed, activeOneOffs };
  }, [items]);

  return (
    <AuthGuard>
      <div className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-7xl space-y-6 p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
                  <CalendarClock className="h-6 w-6 text-primary" />
                  Scheduled Jobs
                </h1>
                <p className="text-sm text-muted-foreground">
                  Recurring agent jobs created for your account. Minimum recurring
                  interval: {formatScheduleInterval(minimumScheduleIntervalSeconds)}.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadSchedules()}
                disabled={refreshing}
              >
                <RefreshCw className={refreshing ? "animate-spin" : ""} />
                Refresh
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Card>
                <CardContent className="flex items-center justify-between p-4">
                  <div>
                    <p className="text-xs font-medium uppercase text-muted-foreground">
                      Active
                    </p>
                    <p className="text-2xl font-semibold">{stats.enabled}</p>
                  </div>
                  <CheckCircle2 className="h-5 w-5 text-green-400" />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="flex items-center justify-between p-4">
                  <div>
                    <p className="text-xs font-medium uppercase text-muted-foreground">
                      Paused
                    </p>
                    <p className="text-2xl font-semibold">{stats.paused}</p>
                  </div>
                  <Clock3 className="h-5 w-5 text-amber-400" />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="flex items-center justify-between p-4">
                  <div>
                    <p className="text-xs font-medium uppercase text-muted-foreground">
                      Failed Last Run
                    </p>
                    <p className="text-2xl font-semibold">{stats.failed}</p>
                  </div>
                  <AlertTriangle className="h-5 w-5 text-red-400" />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="flex items-center justify-between p-4">
                  <div>
                    <p className="text-xs font-medium uppercase text-muted-foreground">
                      Active One-Offs
                    </p>
                    <p className="text-2xl font-semibold">{stats.activeOneOffs}</p>
                  </div>
                  <RefreshCw className="h-5 w-5 text-sky-400" />
                </CardContent>
              </Card>
            </div>

            {error && (
              <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {error}
              </div>
            )}

            <Dialog
              open={Boolean(editingItem)}
              onOpenChange={(open) => {
                if (!open) setEditingItem(null);
              }}
            >
              <DialogContent className="max-h-[90vh] max-w-4xl overflow-hidden">
                {editingItem && (
                  <>
                    <DialogHeader>
                      <DialogTitle>Modify Scheduled Job</DialogTitle>
                      <DialogDescription>
                        {editingItem.schedule_id}
                      </DialogDescription>
                    </DialogHeader>

                    <ScrollArea className="max-h-[68vh] pr-4">
                      <div className="space-y-5">
                        <div className="space-y-2">
                          <Label htmlFor="schedule-title">Title</Label>
                          <Input
                            id="schedule-title"
                            value={editTitle}
                            onChange={(event) => setEditTitle(event.target.value)}
                          />
                        </div>

                        <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
                          <div className="space-y-2">
                            <Label htmlFor="schedule-cron">Cron</Label>
                            <Input
                              id="schedule-cron"
                              value={editCron}
                              onChange={(event) => setEditCron(event.target.value)}
                              className="font-mono"
                            />
                            <p className="text-[11px] text-muted-foreground">
                              Runs must be at least {formatScheduleInterval(
                                minimumScheduleIntervalSeconds
                              )} apart.
                            </p>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="schedule-tz">Timezone</Label>
                            <Input
                              id="schedule-tz"
                              value={editTz}
                              onChange={(event) => setEditTz(event.target.value)}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Status</Label>
                            <div className="flex h-10 items-center">
                              <Badge
                                variant={editingItem.enabled ? "status" : "secondary"}
                                className={editingItem.enabled ? "" : "text-muted-foreground"}
                              >
                                {editingItem.enabled ? "Enabled" : "Paused"}
                              </Badge>
                            </div>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="schedule-message">Message</Label>
                          <Textarea
                            id="schedule-message"
                            value={editMessage}
                            onChange={(event) => setEditMessage(event.target.value)}
                            className="min-h-56 font-mono text-xs"
                          />
                        </div>

                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <div className="text-xs text-muted-foreground">
                            Agent {editingItem.agent_name} - Version {editingItem.version || 1}
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void chatWithEditorAgent(editingItem)}
                            disabled={chattingId === editingItem.schedule_id}
                          >
                            {chattingId === editingItem.schedule_id ? (
                              <RefreshCw className="animate-spin" />
                            ) : (
                              <Bot />
                            )}
                            Chat with agent
                          </Button>
                        </div>

                        <div className="space-y-3">
                          <div className="flex items-center gap-2 text-sm font-medium">
                            <History className="h-4 w-4" />
                            Change History
                          </div>
                          {editingHistory.length === 0 ? (
                            <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
                              No changes recorded yet.
                            </div>
                          ) : (
                            <div className="space-y-2">
                              {editingHistory.map((entry) => {
                                if (entry.kind === "event") {
                                  const event = entry.event;
                                  return (
                                    <div
                                      key={event.event_id || `${event.event_type}-${event.occurred_at}`}
                                      className="rounded-md border px-3 py-3"
                                    >
                                      <div className="flex flex-wrap items-center gap-2">
                                        <Badge variant="secondary">System</Badge>
                                        <div className="text-sm font-medium">
                                          Runner configuration automatically updated
                                        </div>
                                      </div>
                                      <div className="mt-1 flex flex-wrap gap-x-1 text-xs text-muted-foreground">
                                        <span>{formatDateTime(event.occurred_at)}</span>
                                        <span>-</span>
                                        <span>{scheduleEventSourceLabel(event.source)}</span>
                                      </div>
                                      <div className="mt-2 space-y-1">
                                        {event.changed_fields.map((field) => {
                                          const change = event.changes[field] || {};
                                          return (
                                            <div
                                              key={field}
                                              className="grid gap-1 text-xs sm:grid-cols-[minmax(8rem,auto)_1fr]"
                                            >
                                              <span className="text-muted-foreground">
                                                {formatAttributeLabel(field)}
                                              </span>
                                              <div className="flex min-w-0 items-center gap-1 font-mono">
                                                <span className="truncate" title={historyValue(change.before)}>
                                                  {historyValue(change.before)}
                                                </span>
                                                <ChevronRight className="h-3 w-3 shrink-0" />
                                                <span className="truncate" title={historyValue(change.after)}>
                                                  {historyValue(change.after)}
                                                </span>
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  );
                                }

                                const version = entry.version;
                                return (
                                  <div
                                    key={`${version.version}-${version.superseded_at || "unknown"}`}
                                    className="rounded-md border px-3 py-3"
                                  >
                                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                                      <div className="min-w-0 space-y-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <Badge variant="outline">Schedule edit</Badge>
                                          <div className="text-sm font-medium">
                                            Version {version.version}
                                          </div>
                                        </div>
                                        <div className="text-xs text-muted-foreground">
                                          {formatDateTime(version.superseded_at)} -{" "}
                                          {changedFieldsLabel(version)}
                                        </div>
                                        <div className="font-mono text-xs">
                                          {version.cron} - {version.tz}
                                        </div>
                                      </div>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="min-w-24"
                                        onClick={() => void rollbackToVersion(version)}
                                        disabled={mutatingId === editingItem.schedule_id}
                                      >
                                        {mutatingId === editingItem.schedule_id ? (
                                          <RefreshCw className="animate-spin" />
                                        ) : (
                                          <RotateCcw />
                                        )}
                                        Rollback
                                      </Button>
                                    </div>
                                    <code className="mt-2 block max-h-20 overflow-hidden whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                                      {version.message_template}
                                    </code>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    </ScrollArea>

                    <DialogFooter>
                      <Button
                        variant="outline"
                        onClick={() => setEditingItem(null)}
                      >
                        Close
                      </Button>
                      <Button
                        onClick={() => void saveEdit()}
                        disabled={mutatingId === editingItem.schedule_id}
                      >
                        {mutatingId === editingItem.schedule_id ? (
                          <RefreshCw className="animate-spin" />
                        ) : (
                          <Save />
                        )}
                        Save
                      </Button>
                    </DialogFooter>
                  </>
                )}
              </DialogContent>
            </Dialog>

            <Dialog
              open={Boolean(deleteItem)}
              onOpenChange={(open) => {
                if (!open) setDeleteItem(null);
              }}
            >
              <DialogContent className="max-w-md">
                {deleteItem && (
                  <>
                    <DialogHeader>
                      <DialogTitle>Delete Scheduled Job?</DialogTitle>
                      <DialogDescription>
                        Are you sure? This removes the schedule and its Kubernetes CronJob.
                        This cannot be undone.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                      <div className="flex items-start gap-2 text-destructive">
                        <AlertTriangle className="mt-0.5 h-4 w-4" />
                        <div className="font-medium">{scheduleTitle(deleteItem)}</div>
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        schedule_id: {deleteItem.schedule_id}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {deleteItem.cron} - {deleteItem.tz}
                      </div>
                    </div>
                    <DialogFooter>
                      <Button
                        variant="outline"
                        onClick={() => setDeleteItem(null)}
                        disabled={mutatingId === deleteItem.schedule_id}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={() => void deleteSchedule()}
                        disabled={mutatingId === deleteItem.schedule_id}
                      >
                        {mutatingId === deleteItem.schedule_id ? (
                          <RefreshCw className="animate-spin" />
                        ) : (
                          <Trash2 />
                        )}
                        Delete scheduled job
                      </Button>
                    </DialogFooter>
                  </>
                )}
              </DialogContent>
            </Dialog>

            <SchedulesTableFrame>
              <table
                className="w-full text-sm"
                style={{ minWidth: SCHEDULES_TABLE_MIN_WIDTH }}
              >
                <thead className="border-b bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Job</th>
                    <th className="px-4 py-3 text-left font-medium">Schedule</th>
                    <th className="px-4 py-3 text-left font-medium">Message</th>
                    <th className="px-4 py-3 text-left font-medium">Last Run</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                        Loading scheduled jobs...
                      </td>
                    </tr>
                  ) : items.length === 0 ? (
                    <tr>
                      <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                        No scheduled jobs yet.
                      </td>
                    </tr>
                  ) : (
                    items.map((item) => {
                      const attributeEntries = scheduleAttributeEntries(item);
                      const scheduleDescription = humanizeCron(item.cron);
                      const oneOffRuns = item.one_off_runs || [];
                      const activeOneOffCount =
                        oneOffRuns.filter(isActiveOneOff).length;
                      const hasOneOffRuns = oneOffRuns.length > 0;
                      const oneOffExpanded = expandedOneOffIds.has(item.schedule_id);
                      const oneOffSummary = oneOffSummaryLabel(
                        oneOffRuns.length,
                        activeOneOffCount
                      );
                      const oneOffDetailsId = oneOffPanelId(item.schedule_id);

                      return (
                        <Fragment key={item.schedule_id}>
                          <tr className={oneOffExpanded ? "" : "border-b"}>
                            <td className="px-4 py-3 align-top">
                              <div className="space-y-1">
                                <div className="font-medium">{scheduleTitle(item)}</div>
                                <div className="text-xs text-muted-foreground">
                                  agent: {item.agent_name}
                                </div>
                                <div className="font-mono text-xs text-muted-foreground">
                                  schedule_id: {item.schedule_id}
                                </div>
                                {attributeEntries.map(([key, value]) => (
                                  <div
                                    key={key}
                                    className="break-words text-xs text-muted-foreground"
                                  >
                                    <span className="font-medium">
                                      {formatAttributeLabel(key)}:
                                    </span>{" "}
                                    <span className="font-mono">{value}</span>
                                  </div>
                                ))}
                                {hasOneOffRuns && (
                                  <div className="pt-1">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="-ml-2 h-7 px-2 text-xs font-normal text-muted-foreground"
                                      onClick={() => toggleOneOffRuns(item.schedule_id)}
                                      aria-expanded={oneOffExpanded}
                                      aria-controls={oneOffDetailsId}
                                      aria-label={`${
                                        oneOffExpanded ? "Hide" : "Show"
                                      } ${oneOffSummary} for ${item.schedule_id}`}
                                      title="Show one-off runs"
                                      type="button"
                                    >
                                      {oneOffExpanded ? (
                                        <ChevronDown className="h-3.5 w-3.5" />
                                      ) : (
                                        <ChevronRight className="h-3.5 w-3.5" />
                                      )}
                                      <span
                                        className={
                                          activeOneOffCount > 0
                                            ? "text-amber-400"
                                            : ""
                                        }
                                      >
                                        {oneOffSummary}
                                      </span>
                                    </Button>
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3 align-top">
                              <div className="space-y-1">
                                <div className="font-mono">{item.cron}</div>
                                {scheduleDescription && (
                                  <div className="text-xs text-muted-foreground">
                                    {scheduleDescription}
                                  </div>
                                )}
                                <div className="text-xs text-muted-foreground">
                                  Timezone: {item.tz}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  Version {item.version || 1}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  Created {formatRelative(item.created_at, relativeNow)}
                                </div>
                              </div>
                            </td>
                            <td className="max-w-md px-4 py-3 align-top">
                              <code className="block max-h-24 overflow-hidden whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                                {item.message_template}
                              </code>
                            </td>
                            <td className="px-4 py-3 align-top">
                              <div className="space-y-1">
                                <div>{lastRunLabel(item, relativeNow)}</div>
                                {item.last_run?.ts && (
                                  <div className="text-xs text-muted-foreground">
                                    {formatDateTime(item.last_run.ts)}
                                  </div>
                                )}
                                {item.last_run?.error && (
                                  <div className="max-w-xs break-words text-xs text-red-300">
                                    {item.last_run.error}
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3 align-top">
                              <div className="space-y-2">
                                <Badge
                                  variant={item.enabled ? "status" : "secondary"}
                                  className={item.enabled ? "" : "text-muted-foreground"}
                                >
                                  {item.enabled ? "Enabled" : "Paused"}
                                </Badge>
                                {!item.enabled && activeOneOffCount > 0 && (
                                  <div className="max-w-40 text-xs text-amber-300">
                                    Active one-offs need the parent schedule enabled.
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right align-top">
                              <div className="flex flex-col items-end gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="w-28"
                                  onClick={() => openEditor(item)}
                                  disabled={mutatingId === item.schedule_id}
                                  title="Modify schedule"
                                  aria-label={`Modify ${item.schedule_id}`}
                                >
                                  <Pencil />
                                  Modify
                                </Button>
                                <Button
                                  variant={item.enabled ? "outline" : "default"}
                                  size="sm"
                                  className="w-28"
                                  onClick={() => void toggleSchedule(item)}
                                  disabled={mutatingId === item.schedule_id}
                                  title={
                                    item.enabled
                                      ? "Pause scheduled runs"
                                      : "Restart scheduled runs"
                                  }
                                  aria-label={
                                    item.enabled
                                      ? `Pause ${item.schedule_id}`
                                      : `Restart ${item.schedule_id}`
                                  }
                                >
                                  {mutatingId === item.schedule_id ? (
                                    <RefreshCw className="animate-spin" />
                                  ) : item.enabled ? (
                                    <Pause />
                                  ) : (
                                    <Play />
                                  )}
                                  {item.enabled ? "Pause" : "Restart"}
                                </Button>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  className="w-28"
                                  onClick={() => setDeleteItem(item)}
                                  disabled={mutatingId === item.schedule_id}
                                  title="Delete schedule"
                                  aria-label={`Delete ${item.schedule_id}`}
                                >
                                  <Trash2 />
                                  Delete
                                </Button>
                              </div>
                            </td>
                          </tr>
                          {hasOneOffRuns && oneOffExpanded && (
                            <tr
                              id={oneOffDetailsId}
                              className="border-b bg-muted/10"
                            >
                              <td colSpan={6} className="p-0">
                                <div className="px-4 pb-4 pt-1">
                                  <div className="border-t border-border/70 pt-3">
                                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                                      <div className="text-sm font-medium">
                                        One-off fires
                                      </div>
                                      <div className="text-xs text-muted-foreground">
                                        These do not pause or skip the recurring job.
                                      </div>
                                    </div>

                                    <div className="mt-3 overflow-hidden border-y bg-background/60">
                                      <div className="hidden grid-cols-[minmax(10rem,0.9fr)_minmax(14rem,1.1fr)_minmax(16rem,1.4fr)_minmax(12rem,1fr)] gap-3 bg-muted/40 px-3 py-2 text-xs font-medium uppercase text-muted-foreground md:grid">
                                        <div>Status</div>
                                        <div>Run Time</div>
                                        <div>Context</div>
                                        <div>Result</div>
                                      </div>
                                      <div className="divide-y">
                                        {oneOffRuns.map((run) => {
                                          const retryLabel = oneOffRetryLabel(run);
                                          const activePaused =
                                            !item.enabled && isActiveOneOff(run);

                                          return (
                                            <div
                                              key={run.one_off_run_id}
                                              className="grid gap-3 px-3 py-3 md:grid-cols-[minmax(10rem,0.9fr)_minmax(14rem,1.1fr)_minmax(16rem,1.4fr)_minmax(12rem,1fr)] md:items-start"
                                            >
                                              <div className="min-w-0 space-y-1">
                                                <div className="text-xs font-medium uppercase text-muted-foreground md:hidden">
                                                  Status
                                                </div>
                                                <div className="flex flex-wrap items-center gap-2">
                                                  <Badge
                                                    variant={oneOffStatusVariant(run.status)}
                                                  >
                                                    {oneOffStatusLabel(run.status)}
                                                  </Badge>
                                                  {retryLabel && (
                                                    <span className="text-xs text-muted-foreground">
                                                      {retryLabel}
                                                    </span>
                                                  )}
                                                </div>
                                                <div className="font-mono text-xs text-muted-foreground">
                                                  {run.one_off_run_id}
                                                </div>
                                              </div>

                                              <div className="min-w-0 space-y-1">
                                                <div className="text-xs font-medium uppercase text-muted-foreground md:hidden">
                                                  Run Time
                                                </div>
                                                <div className="text-sm">
                                                  {oneOffTimingLabel(run, relativeNow)}
                                                </div>
                                                <div className="text-xs text-muted-foreground">
                                                  {run.run_at
                                                    ? formatDateTime(run.run_at)
                                                    : "No run time recorded"}
                                                </div>
                                              </div>

                                              <div className="min-w-0 space-y-1">
                                                <div className="text-xs font-medium uppercase text-muted-foreground md:hidden">
                                                  Context
                                                </div>
                                                <div className="break-words text-xs text-muted-foreground">
                                                  {oneOffDetailLabel(run)}
                                                </div>
                                              </div>

                                              <div className="min-w-0 space-y-1 text-xs text-muted-foreground">
                                                <div className="font-medium uppercase md:hidden">
                                                  Result
                                                </div>
                                                {run.job_name && (
                                                  <div className="break-words font-mono">
                                                    job: {run.job_name}
                                                  </div>
                                                )}
                                                {run.http_status !== null && (
                                                  <div>HTTP {run.http_status}</div>
                                                )}
                                                {activePaused && (
                                                  <div className="text-amber-300">
                                                    Parent schedule is paused.
                                                  </div>
                                                )}
                                                {run.error && (
                                                  <div className="break-words text-red-300">
                                                    {run.error}
                                                  </div>
                                                )}
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </SchedulesTableFrame>
          </div>
        </ScrollArea>
      </div>
    </AuthGuard>
  );
}
