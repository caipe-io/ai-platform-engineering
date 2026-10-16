"use client";

import { LayoutGrid, LoaderCircle, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AgenticAppCard } from "./AgenticAppCard";
import { matchesAgenticAppSearch } from "@/lib/agentic-apps/hub-search";
import type { PublicAgenticApp } from "@/types/agentic-app";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; apps: PublicAgenticApp[] }
  | { status: "error"; message: string };

export function AgenticAppsHub(): React.ReactElement {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agentic-apps", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          router.push(
            `/login?callbackUrl=${encodeURIComponent(window.location.pathname)}`,
          );
          return null;
        }
        if (!response.ok) throw new Error(`Apps catalog returned HTTP ${response.status}`);
        return response.json() as Promise<{ items: PublicAgenticApp[] }>;
      })
      .then((payload) => {
        if (!cancelled && payload) setState({ status: "ready", apps: payload.items });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Could not load Apps",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  const visibleApps = useMemo(() => {
    if (state.status !== "ready") return [];
    return state.apps.filter((app) => matchesAgenticAppSearch(app, query));
  }, [query, state]);

  return (
    <main className="flex-1 overflow-y-auto bg-background px-6 py-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="relative overflow-hidden rounded-2xl border border-border bg-card px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-primary/10 p-2 text-primary">
              <LayoutGrid className="h-6 w-6" aria-hidden />
            </span>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Apps</h1>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                Discover applications with platform-managed sign-in and navigation.
                Apps can render natively in CAIPE or in a hosted iframe.
              </p>
            </div>
          </div>
        </header>

        {state.status === "loading" ? (
          <div className="flex min-h-64 items-center justify-center rounded-xl border">
            <LoaderCircle className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading Apps" />
          </div>
        ) : null}

        {state.status === "error" ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-6">
            <h2 className="font-semibold">Could not load Apps</h2>
            <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
          </div>
        ) : null}

        {state.status === "ready" ? (
          <>
            {state.apps.length > 0 ? (
              <label className="relative block" aria-label="Search Apps">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <input
                  className="h-11 w-full rounded-lg border bg-background pl-10 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                  type="search"
                  placeholder="Search by app, capability, or category"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
            ) : null}
            {state.apps.length > 0 ? (
              <p className="text-xs text-muted-foreground" aria-live="polite">{visibleApps.length} of {state.apps.length} apps</p>
            ) : null}

            {state.apps.length === 0 ? (
              <section className="rounded-xl border border-dashed p-10 text-center">
                <h2 className="text-lg font-semibold">No Apps are configured</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  An operator can add an app through the deployment-owned catalog.
                </p>
              </section>
            ) : visibleApps.length === 0 ? (
              <section className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
                No Apps match &ldquo;{query.trim()}&rdquo;.
              </section>
            ) : (
              <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-label="Available Apps">
                {visibleApps.map((app) => (
                  <AgenticAppCard key={app.appId} app={app} />
                ))}
              </section>
            )}
          </>
        ) : null}
      </div>
    </main>
  );
}
