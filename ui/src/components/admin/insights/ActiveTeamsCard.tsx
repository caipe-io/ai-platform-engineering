"use client";

import { useEffect, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleLineChart } from "@/components/admin/shared/SimpleLineChart";
import type { ActiveTeamUsage } from "@/lib/active-team-usage";
import { AsyncStatsCard } from "./AsyncStatsCard";

export function ActiveTeamsCard() {
  const [data, setData] = useState<ActiveTeamUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/admin/stats/active-teams?days=30", { signal: controller.signal });
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error("Active team statistics are unavailable.");
        if (!controller.signal.aborted) setData(body.data as ActiveTeamUsage);
      } catch {
        if (!controller.signal.aborted) setError("Active team statistics are unavailable.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  return (
    <AsyncStatsCard loading={loading} error={error} testId="stats-card-active-teams">
      <Card>
        <CardHeader>
          <CardTitle>Active teams</CardTitle>
          <CardDescription>
            Teams with at least one labeled user opening GRID per UTC day. The chart covers the last {data?.retention_days ?? 30} days.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {!data?.enabled ? (
            <p className="text-sm text-muted-foreground">Active team tracking is disabled. Enable APP_USAGE_ENABLED to start collecting daily user counts.</p>
          ) : (
            <>
              <div>
                <h3 className="mb-2 text-sm font-medium">Active teams per day</h3>
                <SimpleLineChart
                  data={data.daily.map((row) => ({
                    label: new Date(`${row.date}T00:00:00.000Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }),
                    value: row.active_teams,
                  }))}
                  height={230}
                  color="rgb(16, 185, 129)"
                />
              </div>
              <div>
                <h3 className="mb-3 text-sm font-medium">Active users by team label · last {data.retention_days} days</h3>
                {data.by_team.length ? (
                  <div className="space-y-3">
                    {data.by_team.map((team) => {
                      const maximum = Math.max(...data.by_team.map((item) => item.active_users), 1);
                      return (
                        <div key={team.team_label} className="grid grid-cols-[minmax(7rem,1fr)_3fr_auto] items-center gap-3 text-sm">
                          <span className="truncate" title={team.team_label}>{team.team_label}</span>
                          <span className="h-2 overflow-hidden rounded bg-muted" aria-hidden="true">
                            <span className="block h-full rounded bg-emerald-500" style={{ width: `${(team.active_users / maximum) * 100}%` }} />
                          </span>
                          <span className="text-right text-muted-foreground">{team.active_users} users · {team.active_days} days</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No labeled users have generated activity during the retention window yet.</p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                A user is active on a day when they open GRID. Daily salted subject hashes are retained for 30 days; email addresses and URLs are not stored. Team labels are read from current user profiles.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </AsyncStatsCard>
  );
}
