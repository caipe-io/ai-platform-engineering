"use client";

import { FavoriteAppCard } from "@/components/home/QuickStart/FavoriteAppCard";
import { normalizeFavoriteAppIds } from "@/lib/agentic-apps/favorites";
import type { PublicAgenticApp } from "@/types/agentic-app";
import { useEffect, useState } from "react";

export function useHomeFavoriteApps(enabled: boolean): PublicAgenticApp[] {
  const [apps, setApps] = useState<PublicAgenticApp[]>([]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();

    const load = async () => {
      try {
        const favoritesResponse = await fetch("/api/settings/preferences/favorite-apps", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!favoritesResponse.ok) throw new Error("Could not load favorite app IDs");
        const saved = await favoritesResponse.json() as { data?: { favoriteAppIds?: unknown } };
        const ids = new Set(normalizeFavoriteAppIds(saved.data?.favoriteAppIds));
        if (ids.size === 0) {
          if (!controller.signal.aborted) setApps([]);
          return;
        }

        const catalogResponse = await fetch("/api/agentic-apps", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!catalogResponse.ok) throw new Error("Could not load favorite apps");
        const catalog = await catalogResponse.json() as { items?: PublicAgenticApp[] };
        if (!controller.signal.aborted) {
          setApps((catalog.items ?? []).filter((app) => app.canLaunch && ids.has(app.appId)));
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("[home] Favorite apps could not be loaded", error);
          setApps([]);
        }
      }
    };

    void load();
    return () => controller.abort();
  }, [enabled]);

  return apps;
}

export function FavoriteAppsWidget({ apps }: { apps: PublicAgenticApp[] }) {
  return (
    <section aria-label="Favorite apps" data-testid="favorite-apps-widget">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground [@media(max-height:800px)]:mb-2">
        Favorite apps
      </h2>
      <div className="home-quick-start-panel rounded-xl border border-border/50 p-4 [@media(max-height:800px)]:p-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 [@media(max-height:800px)]:gap-2">
          {apps.map((app) => <FavoriteAppCard key={app.appId} app={app} />)}
        </div>
      </div>
    </section>
  );
}
