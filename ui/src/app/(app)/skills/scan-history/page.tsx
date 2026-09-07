"use client";

// assisted-by Codex Codex-sonnet-4-6

import { AuthGuard } from "@/components/auth-guard";
import { ScanAllDialog } from "@/components/skills/ScanAllDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ScanStatus } from "@/types/agent-skill";
import {
ArrowLeft,
RefreshCw,
Search,
Shield,
ShieldAlert,
ShieldCheck,
Zap,
} from "lucide-react";
import { useSession } from "next-auth/react";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import { useCallback,useEffect,useMemo,useState } from "react";

type Trigger =
  | "manual_user_skill"
  | "manual_hub_skill"
  | "auto_save"
  | "hub_crawl"
  | "bulk_user_skill"
  | "bulk_hub_skill";
type Source = "agent_skills" | "hub" | "default";

interface HistoryEvent {
  id: string;
  ts: string;
  trigger: Trigger;
  skill_id: string;
  skill_name: string;
  source: Source;
  hub_id?: string;
  actor?: string;
  scan_status: ScanStatus;
  scan_summary?: string;
  scanner_unavailable?: boolean;
  duration_ms?: number;
}

const TRIGGER_LABEL: Record<Trigger, string> = {
  manual_user_skill: "Manual (skill)",
  manual_hub_skill: "Manual (hub)",
  auto_save: "Save",
  hub_crawl: "Hub crawl",
  bulk_user_skill: "Bulk (custom)",
  bulk_hub_skill: "Bulk (hub)",
};

const SOURCE_LABEL: Record<Source, string> = {
  agent_skills: "Custom",
  hub: "Hub",
  default: "Built-in",
};

const PAGE_SIZE = 50;

export default function ScanHistoryPage() {
  const { data: session } = useSession();
  // role lives at session.role (set in NextAuth callbacks via auth-config.ts).
  // Bulk scan is admin-only on the server (`/api/skills/scan-all` checks the
  // same), so we hide the button rather than show a 403 toast.
  const isAdmin =
    (session as { role?: string } | null | undefined)?.role === "admin";

  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scanAllOpen, setScanAllOpen] = useState(false);

  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ScanStatus>("all");
  const [triggerFilter, setTriggerFilter] = useState<"all" | Trigger>("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | Source>("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("page_size", String(PAGE_SIZE));
      if (q.trim()) params.set("q", q.trim());
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (triggerFilter !== "all") params.set("trigger", triggerFilter);
      if (sourceFilter !== "all") params.set("source", sourceFilter);

      const res = await fetch(`/api/skills/scan-history?${params.toString()}`, {
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || data?.message || `Request failed (${res.status})`);
      }
      const payload = data?.data ?? data;
      setEvents(payload.events ?? []);
      setTotal(payload.total ?? 0);
      setHasMore(Boolean(payload.has_more));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load scan history");
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [page, q, statusFilter, triggerFilter, sourceFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const filtersActive = useMemo(
    () => q.trim() !== "" || statusFilter !== "all" || triggerFilter !== "all" || sourceFilter !== "all",
    [q, statusFilter, triggerFilter, sourceFilter],
  );

  const resetFilters = () => {
    setQ("");
    setStatusFilter("all");
    setTriggerFilter("all");
    setSourceFilter("all");
    setPage(1);
  };

  return (
    <AuthGuard>
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-4">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <NavigationProgressLink href="/skills" className="inline-flex items-center gap-1 hover:text-foreground">
                  <ArrowLeft className="h-3.5 w-3.5" /> Skills
                </NavigationProgressLink>
                <span>/</span>
                <span>Scan history</span>
              </div>
              <h1 className="text-xl font-semibold">Skill Scan History</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Review recent skill checks and see what needs attention.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {isAdmin && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => setScanAllOpen(true)}
                  className="gap-2"
                  data-testid="scan-all-open"
                >
                  <Zap className="h-3.5 w-3.5" /> Scan Skills
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={load}
                disabled={loading}
                className="gap-2"
              >
                <RefreshCw
                  className={cn("h-3.5 w-3.5", loading && "animate-spin")}
                />{" "}
                Refresh
              </Button>
            </div>
          </header>

          {isAdmin && (
            <ScanAllDialog
              open={scanAllOpen}
              onOpenChange={setScanAllOpen}
              onComplete={() => {
                // Refresh the audit log once the sweep finishes so the
                // new bulk_* events show up at the top of the list.
                setPage(1);
                load();
              }}
            />
          )}

          <section className="rounded-lg border border-border/60 bg-muted/20 p-3 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
                placeholder="Search skill name…"
                className="pl-8 h-8"
              />
            </div>
            <FilterSelect
              value={statusFilter}
              onChange={(v) => {
                setStatusFilter(v as typeof statusFilter);
                setPage(1);
              }}
              options={[
                { v: "all", l: "All status" },
                { v: "passed", l: "Passed" },
                { v: "flagged", l: "Flagged" },
                { v: "unscanned", l: "Not scanned" },
              ]}
            />
            <FilterSelect
              value={triggerFilter}
              onChange={(v) => {
                setTriggerFilter(v as typeof triggerFilter);
                setPage(1);
              }}
              options={[
                { v: "all", l: "All triggers" },
                { v: "manual_user_skill", l: "Manual (skill)" },
                { v: "manual_hub_skill", l: "Manual (hub)" },
                { v: "auto_save", l: "Save" },
                { v: "hub_crawl", l: "Hub crawl" },
                { v: "bulk_user_skill", l: "Bulk (custom)" },
                { v: "bulk_hub_skill", l: "Bulk (hub)" },
              ]}
            />
            <FilterSelect
              value={sourceFilter}
              onChange={(v) => {
                setSourceFilter(v as typeof sourceFilter);
                setPage(1);
              }}
              options={[
                { v: "all", l: "All sources" },
                { v: "agent_skills", l: "Custom" },
                { v: "hub", l: "Hub" },
                { v: "default", l: "Built-in" },
              ]}
            />
            {filtersActive && (
              <Button variant="ghost" size="sm" onClick={resetFilters} className="text-xs">
                Clear filters
              </Button>
            )}
            <span className="ml-auto text-xs text-muted-foreground">
              {total} event{total === 1 ? "" : "s"}
            </span>
          </section>

          <section className="rounded-lg border border-border/60 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium w-[140px]">When</th>
                    <th className="px-3 py-2 text-left font-medium w-[110px]">Status</th>
                    <th className="px-3 py-2 text-left font-medium">Skill</th>
                    <th className="px-3 py-2 text-left font-medium w-[110px]">Source</th>
                    <th className="px-3 py-2 text-left font-medium w-[140px]">Trigger</th>
                    <th className="px-3 py-2 text-left font-medium w-[160px]">Actor</th>
                    <th className="px-3 py-2 text-right font-medium w-[80px]">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && events.length === 0 ? (
                    <EmptyRow text="Loading…" />
                  ) : error ? (
                    <EmptyRow text={error} className="text-red-600 dark:text-red-400" />
                  ) : events.length === 0 ? (
                    <EmptyRow text="No scan events match these filters." />
                  ) : (
                    events.map((e) => <HistoryRow key={e.id} event={e} />)
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <footer className="flex items-center justify-between gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {page}
              {total > 0 && ` of ${Math.max(1, Math.ceil(total / PAGE_SIZE))}`}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasMore || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </footer>

          <p className="text-xs text-muted-foreground mt-6 border-t border-border pt-4 leading-relaxed">
            Hub ingest uses{" "}
            <a
              href="https://github.com/cisco-ai-defense/skill-scanner"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary font-medium hover:underline"
            >
              Skill Scanner
            </a>
            , provided by <strong>Cisco AI Defense</strong>. Scanner results
            are best-effort and do not guarantee security; a clean scan does
            not imply safety.
          </p>
        </div>
      </div>
    </AuthGuard>
  );
}

function StatusBadge({ status }: { status: ScanStatus }) {
  const Icon = status === "passed" ? ShieldCheck : status === "flagged" ? ShieldAlert : Shield;
  const cls =
    status === "passed"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
      : status === "flagged"
        ? "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30"
        : "bg-muted text-muted-foreground border-border";
  const label = status === "passed" ? "Passed" : status === "flagged" ? "Flagged" : "Not scanned";
  return (
    <Badge variant="outline" className={cn("gap-1 font-normal", cls)}>
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  );
}

function HistoryRow({ event }: { event: HistoryEvent }) {
  const ts = new Date(event.ts);
  const tsLabel = isFinite(ts.getTime())
    ? ts.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
    : event.ts;
  const dur = event.duration_ms != null ? `${Math.round(event.duration_ms)} ms` : "—";

  return (
    <tr className="border-t border-border/60 hover:bg-muted/30">
      <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">{tsLabel}</td>
      <td className="px-3 py-2">
        <StatusBadge status={event.scan_status} />
      </td>
      <td className="px-3 py-2">
        <div className="font-medium truncate" title={event.skill_name}>
          {event.skill_name}
        </div>
        {event.scan_summary && (
          <div
            className="text-xs text-muted-foreground line-clamp-1 mt-0.5"
            title={event.scan_summary}
          >
            {event.scan_summary}
          </div>
        )}
        {event.scanner_unavailable && !event.scan_summary && (
          <div className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
            Scanner unavailable or empty SKILL.md
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-xs">{SOURCE_LABEL[event.source]}</td>
      <td className="px-3 py-2 text-xs">{TRIGGER_LABEL[event.trigger]}</td>
      <td className="px-3 py-2 text-xs text-muted-foreground truncate" title={event.actor || ""}>
        {event.actor || "—"}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground text-right whitespace-nowrap">{dur}</td>
    </tr>
  );
}

function EmptyRow({ text, className }: { text: string; className?: string }) {
  return (
    <tr>
      <td colSpan={7} className={cn("px-3 py-8 text-center text-sm text-muted-foreground", className)}>
        {text}
      </td>
    </tr>
  );
}

function FilterSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { v: string; l: string }[];
}) {
  return (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
    >
      {options.map((o) => (
        <option key={o.v} value={o.v}>
          {o.l}
        </option>
      ))}
    </Select>
  );
}
