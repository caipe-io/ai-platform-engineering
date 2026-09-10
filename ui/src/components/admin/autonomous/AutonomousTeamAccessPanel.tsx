"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

interface TeamAccessRow {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
}

interface TeamAccessResult {
  teams: TeamAccessRow[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
  can_manage: boolean;
}

const PAGE_SIZE = 25;

export function AutonomousTeamAccessPanel() {
  const [data, setData] = useState<TeamAccessResult | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        page_size: String(PAGE_SIZE),
      });
      if (search) params.set("search", search);
      const response = await fetch(`/api/admin/autonomous/team-access?${params.toString()}`);
      const body = (await response.json()) as { data?: TeamAccessResult; error?: string };
      if (!response.ok || !body.data) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      setData(body.data);
      setSelected(new Set());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load team access.");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateAccess = useCallback(
    async (enabled: boolean, options: { all?: boolean; teamIds?: string[] }) => {
      setSaving(true);
      try {
        const response = await fetch("/api/admin/autonomous/team-access", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled,
            all: options.all === true,
            team_ids: options.teamIds,
          }),
        });
        const body = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update team access.");
      } finally {
        setSaving(false);
      }
    },
    [load],
  );

  const rows = data?.teams ?? [];
  const allPageSelected = rows.length > 0 && rows.every((team) => selected.has(team.id));
  const canManage = data?.can_manage === true;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Team access</h2>
        <p className="text-sm text-muted-foreground">
          Allow members of selected teams to use Autonomous with any agent they can already use.
          Membership in one enabled team is enough.
        </p>
      </div>

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setSearch(query.trim());
        }}
      >
        <Input
          aria-label="Search teams"
          className="max-w-sm"
          placeholder="Search teams"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" variant="outline">Search</Button>
      </form>

      {error && <div className="text-sm text-destructive">{error}</div>}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!canManage || saving || selected.size === 0}
          onClick={() => void updateAccess(true, { teamIds: [...selected] })}
        >
          Enable selected
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canManage || saving || selected.size === 0}
          onClick={() => void updateAccess(false, { teamIds: [...selected] })}
        >
          Disable selected
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canManage || saving || (data?.total ?? 0) === 0}
          onClick={() => void updateAccess(true, { all: true })}
        >
          Enable all teams
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canManage || saving || (data?.total ?? 0) === 0}
          onClick={() => void updateAccess(false, { all: true })}
        >
          Disable all teams
        </Button>
      </div>

      <div className="overflow-hidden rounded-md border">
        <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_8rem] items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
          <input
            type="checkbox"
            aria-label="Select all teams on this page"
            checked={allPageSelected}
            disabled={rows.length === 0}
            onChange={(event) => {
              setSelected(event.target.checked ? new Set(rows.map((team) => team.id)) : new Set());
            }}
          />
          <span>Team</span>
          <span className="text-right">Autonomous</span>
        </div>

        {loading ? (
          <div className="p-4 text-sm text-muted-foreground">Loading teams…</div>
        ) : rows.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">No teams found.</div>
        ) : (
          rows.map((team) => (
            <div
              key={team.id}
              className="grid grid-cols-[2.5rem_minmax(0,1fr)_8rem] items-center gap-3 border-b px-3 py-3 last:border-b-0"
            >
              <input
                type="checkbox"
                aria-label={`Select ${team.name}`}
                checked={selected.has(team.id)}
                onChange={(event) => {
                  setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(team.id);
                    else next.delete(team.id);
                    return next;
                  });
                }}
              />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{team.name}</div>
                <div className="truncate text-xs text-muted-foreground">{team.slug}</div>
              </div>
              <div className="flex justify-end">
                <Switch
                  aria-label={`Allow ${team.name} to use Autonomous`}
                  checked={team.enabled}
                  disabled={!canManage || saving}
                  onCheckedChange={(enabled) =>
                    void updateAccess(enabled, { teamIds: [team.id] })
                  }
                />
              </div>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{data ? `${data.total} team${data.total === 1 ? "" : "s"}` : ""}</span>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading || page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading || !data?.has_more}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
