"use client";

import { ArrowUpRight, LayoutGrid, LoaderCircle, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AgenticAppCard } from "./AgenticAppCard";
import { apiClient } from "@/lib/api-client";
import { matchesAgenticAppSearch } from "@/lib/agentic-apps/hub-search";
import { normalizeFavoriteAppIds } from "@/lib/agentic-apps/favorites";
import type { PublicAgenticApp } from "@/types/agentic-app";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; apps: PublicAgenticApp[] }
  | { status: "error"; message: string };

export function AgenticAppsHub(): React.ReactElement {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [favoriteAppIds, setFavoriteAppIds] = useState<string[]>([]);
  const [favoritesReady, setFavoritesReady] = useState(false);
  const [favoritePending, setFavoritePending] = useState(false);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);

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

    apiClient.getSettings()
      .then((settings) => {
        if (cancelled) return;
        setFavoriteAppIds(normalizeFavoriteAppIds(settings.preferences.favorite_agentic_apps));
        setFavoritesReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setFavoriteError("Favorites are unavailable while preferences cannot be loaded.");
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

  async function toggleFavorite(appId: string): Promise<void> {
    if (!favoritesReady || favoritePending) return;
    const previous = favoriteAppIds;
    const next = previous.includes(appId)
      ? previous.filter(id => id !== appId) : [...previous, appId];
    setFavoriteAppIds(next);
    setFavoritePending(true);
    setFavoriteError(null);
    try {
      const saved = await apiClient.updatePreferences({ favorite_agentic_apps: next });
      setFavoriteAppIds(normalizeFavoriteAppIds(saved.preferences.favorite_agentic_apps));
    } catch {
      setFavoriteAppIds(previous);
      setFavoriteError("Could not save favorites. Try again.");
    } finally {
      setFavoritePending(false);
    }
  }

  return (
    <main className="flex-1 overflow-y-auto bg-background px-5 py-5 text-foreground">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <header className="relative overflow-hidden rounded-[1.25rem] border border-border bg-card/60 px-5 py-4 shadow-lg backdrop-blur">
          <div aria-hidden className="absolute -right-20 -top-28 h-52 w-52 rounded-full bg-primary/15 blur-3xl" />
          <div className="relative flex items-center gap-3">
            <span className="rounded-xl bg-primary/10 p-2 text-primary">
              <LayoutGrid className="h-6 w-6" aria-hidden />
            </span>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Apps</h1>
              <p className="mt-1 max-w-4xl text-sm leading-5 text-muted-foreground">
                Discover trusted apps with platform-managed sign-in, navigation, authorization, credentials, and policy.
              </p>
            </div>
          </div>
          <a
            href="https://github.com/caipe-io/ai-platform-engineering/blob/main/docs/docs/features/agentic-app-manifest.md"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Build a CAIPE app (opens in a new tab)"
            className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Build a CAIPE app <ArrowUpRight className="h-4 w-4" aria-hidden />
          </a>
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
              <section aria-label="Search Apps" className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3">
                <label className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <input className="h-11 w-full appearance-none rounded-xl border border-border bg-background py-2 pl-10 pr-11 text-sm text-foreground outline-none transition placeholder:text-muted-foreground hover:border-primary/40 focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
                    type="search" placeholder="Search by app, capability, or category" aria-label="Search apps"
                    value={query} onChange={(event) => setQuery(event.target.value)} />
                  {query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear search"
                    className="absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground">
                    <X className="h-4 w-4" aria-hidden />
                  </button> : null}
                </label>
                <p className="shrink-0 px-1 text-xs font-medium text-muted-foreground" aria-live="polite">
                  {query.trim() ? `${visibleApps.length} of ${state.apps.length} apps` : `${state.apps.length} ${state.apps.length === 1 ? "app" : "apps"}`}
                </p>
              </section>
            ) : null}
            {favoriteError ? <p role="alert" className="text-sm text-destructive">{favoriteError}</p> : null}

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
                  <AgenticAppCard key={app.appId} app={app}
                    isFavorite={favoriteAppIds.includes(app.appId)} favoritePending={!favoritesReady || favoritePending}
                    onToggleFavorite={() => void toggleFavorite(app.appId)} />
                ))}
              </section>
            )}
          </>
        ) : null}
      </div>
    </main>
  );
}
