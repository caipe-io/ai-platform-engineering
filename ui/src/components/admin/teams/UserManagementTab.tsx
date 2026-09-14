"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MultiSelect } from "@/components/ui/multi-select";
import { Select } from "@/components/ui/select";
import {
  withAdminSimulationParams,
  type AdminSimulationQueryTarget,
} from "@/lib/rbac/admin-simulation-query";
import { AlertCircle,ChevronLeft,ChevronRight,Loader2 } from "lucide-react";
import { usePathname,useRouter,useSearchParams } from "next/navigation";
import {
useCallback,
useEffect,
useMemo,
useRef,
useState,
} from "react";

const PAGE_SIZE = 20;

const UM_SEARCH = "umSearch";
const UM_PAGE = "umPage";
const UM_TEAMS = "umTeams";
const UM_SLACK = "umSlack";
const UM_WEBEX = "umWebex";
const UM_ENABLED = "umEnabled";

type SlackFilter = "all" | "linked" | "unlinked";
type WebexFilter = "all" | "linked" | "unlinked";
type EnabledFilter = "all" | "enabled" | "disabled";

interface AdminUserRow {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  enabled: boolean;
  attributes: Record<string, string[]>;
  slack_link_status?: "linked" | "unlinked";
  webex_link_status?: "linked" | "unlinked";
}

interface TeamListItem {
  _id: string;
  name: string;
  members?: Array<{ user_id: string; role: string }>;
}

export interface UserManagementTabProps {
  onSelectUser: (userId: string) => void;
  simulationTarget?: AdminSimulationQueryTarget | null;
}

function parseListParam(raw: string | null): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isSlackLinked(u: AdminUserRow): boolean {
  return slackStatusForUser(u) !== "unlinked";
}

function slackStatusForUser(u: AdminUserRow): "linked" | "unlinked" {
  if (u.slack_link_status === "linked" || u.slack_link_status === "unlinked") {
    return u.slack_link_status;
  }
  const sid = u.attributes?.slack_user_id;
  const v = Array.isArray(sid) ? sid[0] : sid;
  return v != null && String(v).trim() !== "" ? "linked" : "unlinked";
}

function webexStatusForUser(u: AdminUserRow): "linked" | "unlinked" {
  if (u.webex_link_status === "linked" || u.webex_link_status === "unlinked") {
    return u.webex_link_status;
  }
  const wid = u.attributes?.webex_user_id;
  const v = Array.isArray(wid) ? wid[0] : wid;
  return v != null && String(v).trim() !== "" ? "linked" : "unlinked";
}

export function UserManagementTab({
  onSelectUser,
  simulationTarget = null,
}: UserManagementTabProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const skipSearchDraftSyncRef = useRef(false);
  const withPreviewScope = useCallback(
    (path: string) => withAdminSimulationParams(path, simulationTarget),
    [simulationTarget],
  );

  const page = Math.max(
    1,
    parseInt(searchParams.get(UM_PAGE) ?? "1", 10) || 1
  );
  const teamsFilter = useMemo(
    () => parseListParam(searchParams.get(UM_TEAMS)),
    [searchParams]
  );
  const slackFilter = (searchParams.get(UM_SLACK) ?? "all") as SlackFilter;
  const webexFilter = (searchParams.get(UM_WEBEX) ?? "all") as WebexFilter;
  const enabledFilter = (searchParams.get(UM_ENABLED) ??
    "all") as EnabledFilter;
  const searchFromUrl = searchParams.get(UM_SEARCH) ?? "";

  const [searchDraft, setSearchDraft] = useState(searchFromUrl);

  useEffect(() => {
    if (skipSearchDraftSyncRef.current) {
      skipSearchDraftSyncRef.current = false;
      return;
    }
    setSearchDraft(searchFromUrl);
  }, [searchFromUrl]);

  const [debouncedSearch, setDebouncedSearch] = useState(searchFromUrl);
  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebouncedSearch(searchDraft);
    }, 300);
    return () => window.clearTimeout(id);
  }, [searchDraft]);

  useEffect(() => {
    if (debouncedSearch === searchFromUrl) return;
    const p = new URLSearchParams(searchParams.toString());
    if (debouncedSearch.trim()) p.set(UM_SEARCH, debouncedSearch.trim());
    else p.delete(UM_SEARCH);
    p.set(UM_PAGE, "1");
    skipSearchDraftSyncRef.current = true;
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  }, [debouncedSearch, searchFromUrl, pathname, router, searchParams]);

  const patchUrl = useCallback(
    (patch: Record<string, string | null>) => {
      const p = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "") p.delete(k);
        else p.set(k, v);
      }
      router.replace(`${pathname}?${p.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  const setPage = (next: number) => {
    patchUrl({ [UM_PAGE]: next <= 1 ? null : String(next) });
  };

  const setTeamsFilter = (next: string[]) => {
    patchUrl({
      [UM_TEAMS]: next.length ? next.join(",") : null,
      [UM_PAGE]: null,
    });
  };


  const setSlackFilter = (v: SlackFilter) => {
    patchUrl({
      [UM_SLACK]: v === "all" ? null : v,
      [UM_PAGE]: null,
    });
  };

  const setWebexFilter = (v: WebexFilter) => {
    patchUrl({
      [UM_WEBEX]: v === "all" ? null : v,
      [UM_PAGE]: null,
    });
  };

  const setEnabledFilter = (v: EnabledFilter) => {
    patchUrl({
      [UM_ENABLED]: v === "all" ? null : v,
      [UM_PAGE]: null,
    });
  };

  const [teams, setTeams] = useState<TeamListItem[]>([]);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTeams([]);
    (async () => {
      try {
        const res = await fetch(withPreviewScope("/api/admin/teams"));
        const json = await res.json();
        if (!json.success) return;
        if (!cancelled) {
          setTeams((json.data?.teams as TeamListItem[] | undefined) ?? []);
        }
      } catch {
        if (!cancelled) setTeams([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [withPreviewScope]);


  // The shared MultiSelect works on plain string options, while `teamsFilter`
  // (URL state + backend `?team=`) is keyed by team id. Bridge the two with
  // name<->id maps so the picker shows names but selection stays id-based.
  const sortedTeams = useMemo(
    () => teams.slice().sort((a, b) => a.name.localeCompare(b.name)),
    [teams]
  );
  const teamNameOptions = useMemo(() => sortedTeams.map((t) => t.name), [sortedTeams]);
  const nameToId = useMemo(
    () => new Map(sortedTeams.map((t) => [t.name, t._id])),
    [sortedTeams]
  );
  const idToName = useMemo(
    () => new Map(sortedTeams.map((t) => [t._id, t.name])),
    [sortedTeams]
  );
  const selectedTeamNames = useMemo(
    () => teamsFilter.map((id) => idToName.get(id)).filter((n): n is string => Boolean(n)),
    [teamsFilter, idToName]
  );

  const teamsFilterKey = teamsFilter.join("\u0001");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setUsers([]);
      setTotal(0);
      try {
        const qs = new URLSearchParams();
        qs.set("page", String(page));
        qs.set("pageSize", String(PAGE_SIZE));
        const q = searchFromUrl.trim();
        if (q) qs.set("search", q);
        if (teamsFilter.length >= 1) qs.set("team", teamsFilter[0]);
        if (slackFilter === "linked" || slackFilter === "unlinked") {
          qs.set("slackStatus", slackFilter);
        }
        if (webexFilter === "linked" || webexFilter === "unlinked") {
          qs.set("webexStatus", webexFilter);
        }
        if (enabledFilter === "enabled") qs.set("enabled", "true");
        if (enabledFilter === "disabled") qs.set("enabled", "false");

        const res = await fetch(withPreviewScope(`/api/admin/users?${qs.toString()}`));
        const data = await res.json();
        if (!res.ok) {
          throw new Error(
            typeof data.error === "string"
              ? data.error
              : "Failed to load users"
          );
        }
        const rows = (data.users as AdminUserRow[] | undefined) ?? [];
        if (!cancelled) {
          setUsers(rows);
          setTotal(typeof data.total === "number" ? data.total : 0);
        }
      } catch (e) {
        if (!cancelled) {
          setUsers([]);
          setTotal(0);
          setError(e instanceof Error ? e.message : "Failed to load users");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    page,
    searchFromUrl,
    teamsFilter,
    teamsFilterKey,
    slackFilter,
    webexFilter,
    enabledFilter,
    withPreviewScope,
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="space-y-4">
      {error && (
        <div
          className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div
        className="flex flex-wrap items-end gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-1 min-w-[200px] flex-1">
          <span className="text-xs font-medium text-muted-foreground">
            Search
          </span>
          <Input
            placeholder="Name, email, username…"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            className="h-9"
          />
        </div>
        <div className="flex flex-col gap-1 min-w-[140px]">
          <span className="text-xs font-medium text-muted-foreground">Teams</span>
          <MultiSelect
            options={teamNameOptions}
            selected={selectedTeamNames}
            onChange={(names) =>
              setTeamsFilter(
                names.map((n) => nameToId.get(n)).filter((id): id is string => Boolean(id))
              )
            }
            placeholder="All teams"
            searchPlaceholder="Search teams..."
            badgeLabel="teams"
            className="h-9"
          />
        </div>
        <div className="flex flex-col gap-1 min-w-[130px]">
          <span className="text-xs font-medium text-muted-foreground">
            Slack
          </span>
          <Select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={slackFilter}
            onChange={(e) => setSlackFilter(e.target.value as SlackFilter)}
          >
            <option value="all">All</option>
            <option value="linked">Linked</option>
            <option value="unlinked">Unlinked</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1 min-w-[130px]">
          <span className="text-xs font-medium text-muted-foreground">Webex</span>
          <Select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={webexFilter}
            onChange={(e) => setWebexFilter(e.target.value as WebexFilter)}
          >
            <option value="all">All</option>
            <option value="linked">Linked</option>
            <option value="unlinked">Unlinked</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1 min-w-[130px]">
          <span className="text-xs font-medium text-muted-foreground">
            Enabled
          </span>
          <Select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={enabledFilter}
            onChange={(e) =>
              setEnabledFilter(e.target.value as EnabledFilter)
            }
          >
            <option value="all">All</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </Select>
        </div>
      </div>

      <div className="rounded-lg border border-border overflow-hidden bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Slack</th>
                <th className="px-4 py-3">Webex</th>
                <th className="px-4 py-3 w-20">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-16 text-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <Loader2 className="h-8 w-8 animate-spin" />
                      <span>Loading…</span>
                    </div>
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-12 text-center text-muted-foreground"
                  >
                    No users match the current filters.
                  </td>
                </tr>
              ) : (
                users.map((u, idx) => {
                  const name =
                    [u.firstName, u.lastName].filter(Boolean).join(" ") ||
                    u.username ||
                    "—";
                  const linked = isSlackLinked(u);
                  const webexStatus = webexStatusForUser(u);
                  return (
                    <tr
                      key={u.id}
                      onClick={() => onSelectUser(u.id)}
                      className={`border-b border-border/60 cursor-pointer transition-colors hover:bg-muted/50 ${
                        idx % 2 === 1 ? "bg-muted/20" : ""
                      }`}
                    >
                      <td className="px-4 py-2.5 font-medium">{name}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {u.email || "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        {linked ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/25">
                            Linked
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground border border-border">
                            Unlinked
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {webexStatus === "linked" ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/25">
                            Linked
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground border border-border">
                            Unlinked
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-1.5">
                          <span
                            className={`h-2 w-2 rounded-full shrink-0 ${
                              u.enabled ? "bg-emerald-500" : "bg-red-500"
                            }`}
                            aria-hidden
                          />
                          <span className="sr-only">
                            {u.enabled ? "Enabled" : "Disabled"}
                          </span>
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          <span>
            {total === 0
              ? "Showing 0 users"
              : `Showing ${from}-${to} of ${total} users`}
          </span>
          <div className="flex items-center gap-2">
            <span className="text-xs tabular-nums">
              Page {page} / {totalPages}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0"
              disabled={page <= 1 || loading}
              onClick={() => setPage(page - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0"
              disabled={page >= totalPages || loading}
              onClick={() => setPage(page + 1)}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
