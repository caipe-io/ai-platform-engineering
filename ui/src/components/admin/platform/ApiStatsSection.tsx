"use client";

import { SimpleLineChart } from "@/components/admin/shared/SimpleLineChart";
import { AsyncStatsCard } from "@/components/admin/insights/AsyncStatsCard";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AdminApiStats } from "@/types/admin-stats";
import { KeyRound, Terminal } from "lucide-react";

interface ApiStatsSectionProps {
  api?: AdminApiStats;
  error?: string | null;
  loading?: boolean;
  rangeLabel: string;
}

export function ApiStatsSection({ api, error, loading = false, rangeLabel }: ApiStatsSectionProps) {
  if (!api && !loading && !error) return null;

  const mcpActivity = api?.mcp_activity;

  return (
    <div className="space-y-4">
      {/* Section Header */}
      <div className="flex items-center gap-2 pt-2">
        <KeyRound className="h-5 w-5 text-muted-foreground" />
        <h3 className="text-lg font-semibold">API</h3>
      </div>
      <div className="h-px bg-border" />

      {/* Activity — direct API callers (e.g. scripts hitting the chat API with
          a Bearer token). No channel/space concept exists for this source, so
          unlike Slack/Webex there is no Top X breakdown. */}
      {((api?.daily.length ?? 0) > 0 || loading) && (
        <AsyncStatsCard
          error={error}
          loading={loading}
          minHeightClassName="min-h-80"
          testId="stats-card-api-daily-activity"
        >
          {api && api.daily.length > 0 ? <Card>
          <CardHeader>
            <CardTitle>Daily API Activity ({rangeLabel})</CardTitle>
            <CardDescription>Direct API conversation interactions per day</CardDescription>
          </CardHeader>
          <CardContent>
            <SimpleLineChart
              data={api.daily.map((day) => ({
                label: new Date(day.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                value: day.interactions,
              }))}
              height={200}
              color="rgb(20, 184, 166)"
            />
            <div className="mt-4 grid grid-cols-2 gap-4 text-center">
              <div>
                <p className="text-lg font-bold">
                  {Math.round(api.daily.reduce((sum, d) => sum + d.interactions, 0) / Math.max(api.daily.length, 1))}
                </p>
                <p className="text-xs text-muted-foreground">Avg/Day</p>
              </div>
              <div>
                <p className="text-lg font-bold text-teal-500">
                  {Math.round(api.daily.reduce((sum, d) => sum + d.unique_users, 0) / Math.max(api.daily.length, 1))}
                </p>
                <p className="text-xs text-muted-foreground">Avg Users/Day</p>
              </div>
            </div>
          </CardContent>
          </Card> : undefined}
        </AsyncStatsCard>
      )}

      {/* Direct MCP Activity — a separate data source (the audit-service),
          not the conversations/messages collections above. Admin-only: the
          server omits `mcp_activity` entirely for a non-admin, so absence
          here is expected and renders nothing rather than an error. */}
      {(mcpActivity !== undefined || loading) && (
        <AsyncStatsCard
          error={error}
          loading={loading}
          minHeightClassName="min-h-80"
          testId="stats-card-api-mcp-activity"
        >
          {mcpActivity ? <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Terminal className="h-5 w-5" />
              Direct MCP Activity
            </CardTitle>
            <CardDescription>
              MCP tool calls from local agent clients (e.g. Claude Code, Codex) via the agent gateway
            </CardDescription>
          </CardHeader>
          <CardContent>
            {mcpActivity.unavailable ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                Audit service unavailable — Direct MCP Activity could not be loaded
              </p>
            ) : (
              <>
                <div className="flex items-baseline gap-4">
                  <div>
                    <p className="text-3xl font-bold">{mcpActivity.total_events.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">total events</p>
                  </div>
                  <div>
                    <p className="text-3xl font-bold text-teal-500">{mcpActivity.unique_users.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">unique users</p>
                  </div>
                </div>
                {mcpActivity.range_capped && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Showing the most recent 31 days — the audit service does not retain a longer query range.
                  </p>
                )}
                {mcpActivity.daily.length > 0 && (
                  <div className="mt-4">
                    <SimpleLineChart
                      data={mcpActivity.daily.map((day) => ({
                        label: new Date(day.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                        value: day.events,
                      }))}
                      height={160}
                      color="rgb(168, 85, 247)"
                    />
                  </div>
                )}
              </>
            )}
          </CardContent>
          </Card> : undefined}
        </AsyncStatsCard>
      )}
    </div>
  );
}
