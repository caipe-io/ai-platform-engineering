"use client";

import { ArrowUpRight, LayoutGrid, LoaderCircle, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { PublicAgenticApp } from "@/types/agentic-app";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; apps: PublicAgenticApp[] }
  | { status: "error"; message: string };

export function AgenticAppsHub(): React.ReactElement {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agentic-apps", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          window.location.assign(
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
  }, []);

  const visibleApps = useMemo(() => {
    if (state.status !== "ready") return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return state.apps;
    return state.apps.filter((app) =>
      [
        app.displayName,
        app.description,
        ...app.categories,
        ...app.capabilities,
      ].some((value) => value.toLowerCase().includes(needle)),
    );
  }, [query, state]);

  return (
    <main className="flex-1 overflow-y-auto bg-background px-6 py-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header>
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-primary/10 p-2 text-primary">
              <LayoutGrid className="h-6 w-6" aria-hidden />
            </span>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Apps</h1>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                Open web applications registered by your platform team. Each app runs
                independently while CAIPE provides sign-in, navigation, and a secure
                same-origin connection.
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
                  placeholder="Search Apps"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
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
              <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Available Apps">
                {visibleApps.map((app) => (
                  <article key={app.appId} className="flex min-h-56 flex-col rounded-xl border bg-card p-5 shadow-sm">
                    <div className="flex items-start justify-between gap-4">
                      <span className="rounded-lg bg-primary/10 p-2 text-primary">
                        <LayoutGrid className="h-5 w-5" aria-hidden />
                      </span>
                      {app.categories[0] ? (
                        <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                          {app.categories[0]}
                        </span>
                      ) : null}
                    </div>
                    <h2 className="mt-4 text-lg font-semibold">{app.displayName}</h2>
                    <p className="mt-2 flex-1 text-sm leading-6 text-muted-foreground">
                      {app.description}
                    </p>
                    {app.canLaunch ? (
                      <a
                        className="mt-5 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                        href={app.href}
                      >
                        Open <ArrowUpRight className="h-4 w-4" aria-hidden />
                      </a>
                    ) : (
                      <span className="mt-5 rounded-lg border px-4 py-2 text-center text-sm text-muted-foreground">
                        Access required
                      </span>
                    )}
                  </article>
                ))}
              </section>
            )}
          </>
        ) : null}
      </div>
    </main>
  );
}
