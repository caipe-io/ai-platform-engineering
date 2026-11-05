"use client";

import { AsyncStatsCard } from "./AsyncStatsCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AppUsageSummary } from "@/lib/app-usage";
import { useEffect, useState } from "react";

export function AppUsageCard() {
  const [data, setData] = useState<AppUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setError("Application load counts are unavailable.");
      setLoading(false);
      controller.abort();
    }, 10_000);
    void (async () => {
      try {
        const response = await fetch("/api/admin/stats/app-usage", { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401 || response.status === 403) {
          setDenied(true);
          return;
        }
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error("Usage unavailable");
        if (!controller.signal.aborted) setData(body.data);
      } catch {
        if (!controller.signal.aborted) setError("Application load counts are unavailable.");
      } finally {
        window.clearTimeout(timeout);
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [revision]);

  if (denied) return null;
  return (
    <AsyncStatsCard loading={loading} error={error} testId="stats-card-app-usage">
      <Card>
        <CardHeader>
          <CardTitle>Application shell loads</CardTitle>
          <CardDescription>Platform-wide, last 30 UTC days. Not unique visitors or client-side page views; dashboard filters do not apply.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {data?.enabled ? <>
            <p className="text-2xl font-semibold">{data.total_loads.toLocaleString()} loads</p>
            <details>
              <summary className="cursor-pointer text-sm">Recorded daily counts</summary>
              <table className="mt-2 w-full text-sm">
                <caption className="sr-only">Application shell loads by UTC date</caption>
                <thead><tr><th scope="col" className="text-left">UTC date</th><th scope="col" className="text-right">Loads</th></tr></thead>
                <tbody>{data.daily.map((row) => <tr key={row.date}><td>{row.date}</td><td className="text-right">{row.loads.toLocaleString()}</td></tr>)}</tbody>
              </table>
            </details>
            <p className="text-xs text-muted-foreground">No user identities or URLs are stored. Daily counters expire after 30 days.</p>
          </> : data ? <p className="text-sm text-muted-foreground">Aggregate usage collection is disabled.</p> : null}
          <Button variant="outline" size="sm" disabled={loading} onClick={() => {
            setError(null);
            setLoading(true);
            setRevision((value) => value + 1);
          }}>Refresh load counts</Button>
        </CardContent>
      </Card>
    </AsyncStatsCard>
  );
}
