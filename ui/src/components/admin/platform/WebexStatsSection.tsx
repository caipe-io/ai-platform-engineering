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
import type { AdminWebexStats } from "@/types/admin-stats";
import { MessageCircle } from "lucide-react";

interface WebexStatsSectionProps {
  error?: string | null;
  loading?: boolean;
  rangeLabel: string;
  webex?: AdminWebexStats;
}

export function WebexStatsSection({ error, loading = false, webex, rangeLabel }: WebexStatsSectionProps) {
  if (!webex && !loading && !error) return null;

  return (
    <div className="space-y-4">
      {/* Section Header */}
      <div className="flex items-center gap-2 pt-2">
        <MessageCircle className="h-5 w-5 text-muted-foreground" />
        <h3 className="text-lg font-semibold">Webex</h3>
      </div>
      <div className="h-px bg-border" />

      {/* Configured Spaces */}
      {(webex?.configured_spaces !== undefined || loading) && (
        <AsyncStatsCard
          error={error}
          loading={loading}
          minHeightClassName="min-h-72"
          testId="stats-card-webex-configured-spaces"
        >
          {webex?.configured_spaces !== undefined ? <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5" />
              Configured Spaces
            </CardTitle>
            <CardDescription>Webex spaces wired to an agent</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <p className="text-3xl font-bold">{webex.configured_spaces.toLocaleString()}</p>
              <p className="text-sm text-muted-foreground">currently configured</p>
            </div>
            {webex.configured_spaces_daily && webex.configured_spaces_daily.length > 0 && (
              <div className="mt-4">
                <p className="text-xs text-muted-foreground mb-2">Configured spaces over time ({rangeLabel})</p>
                <SimpleLineChart
                  data={webex.configured_spaces_daily.map((point) => ({
                    label: new Date(point.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                    value: point.total,
                  }))}
                  height={160}
                  color="rgb(168, 85, 247)"
                />
              </div>
            )}
          </CardContent>
          </Card> : undefined}
        </AsyncStatsCard>
      )}

      {/* Daily Activity Chart */}
      {((webex?.daily.length ?? 0) > 0 || loading) && (
        <AsyncStatsCard
          error={error}
          loading={loading}
          minHeightClassName="min-h-80"
          testId="stats-card-webex-daily-activity"
        >
          {webex && webex.daily.length > 0 ? <Card>
          <CardHeader>
            <CardTitle>Daily Webex Activity ({rangeLabel})</CardTitle>
            <CardDescription>Thread interactions per day</CardDescription>
          </CardHeader>
          <CardContent>
            <SimpleLineChart
              data={webex.daily.map((day) => ({
                label: new Date(day.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                value: day.interactions,
              }))}
              height={200}
              color="rgb(59, 130, 246)"
            />
            <div className="mt-4 grid grid-cols-2 gap-4 text-center">
              <div>
                <p className="text-lg font-bold">
                  {Math.round(webex.daily.reduce((sum, d) => sum + d.interactions, 0) / Math.max(webex.daily.length, 1))}
                </p>
                <p className="text-xs text-muted-foreground">Avg/Day</p>
              </div>
              <div>
                <p className="text-lg font-bold text-purple-500">
                  {Math.round(webex.daily.reduce((sum, d) => sum + d.unique_users, 0) / Math.max(webex.daily.length, 1))}
                </p>
                <p className="text-xs text-muted-foreground">Avg Users/Day</p>
              </div>
            </div>
          </CardContent>
          </Card> : undefined}
        </AsyncStatsCard>
      )}

      {/* Top Spaces */}
      <AsyncStatsCard
        error={error}
        loading={loading}
        minHeightClassName="min-h-56"
        testId="stats-card-webex-top-spaces"
      >
        {webex ? <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5" />
            Top Spaces
          </CardTitle>
          <CardDescription>Most active Webex spaces</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {webex.top_spaces.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No space data yet</p>
            ) : webex.top_spaces.map((space, i) => {
              const maxCount = webex.top_spaces[0].interactions;
              const pct = maxCount > 0 ? (space.interactions / maxCount) * 100 : 0;
              return (
                <div key={space.space_name}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <div className="w-6 text-sm text-muted-foreground">#{i + 1}</div>
                      <div className="text-sm font-medium">{space.space_name}</div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {space.interactions} interactions
                    </div>
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden ml-8">
                    <div
                      className="h-full bg-primary rounded-full transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
        </Card> : undefined}
      </AsyncStatsCard>
    </div>
  );
}
