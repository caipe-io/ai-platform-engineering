"use client";

import { useEffect, useState } from "react";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import { Tabs,TabsContent,TabsList,TabsTrigger } from "@/components/ui/tabs";
import { FavoriteAppCard } from "./FavoriteAppCard";
import { normalizeFavoriteAppIds } from "@/lib/agentic-apps/favorites";
import type { PublicAgenticApp } from "@/types/agentic-app";
import { QUICK_START_TABS } from "./quickStartCards";
import { QuickStartCard } from "./QuickStartCard";

type FavoritesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; apps: PublicAgenticApp[] }
  | { status: "error" };

export function QuickStartSection() {
  const [activeTab, setActiveTab] = useState(QUICK_START_TABS[0].id as string);
  const [favorites, setFavorites] = useState<FavoritesState>({ status: "idle" });

  useEffect(() => {
    if (activeTab !== "favorites") return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const [catalogResponse, favoritesResponse] = await Promise.all([
          fetch("/api/agentic-apps", { cache: "no-store", signal: controller.signal }),
          fetch("/api/settings/preferences/favorite-apps", { cache: "no-store", signal: controller.signal }),
        ]);
        if (!catalogResponse.ok || !favoritesResponse.ok) throw new Error("Could not load favorites");
        const catalog = await catalogResponse.json() as { items: PublicAgenticApp[] };
        const saved = await favoritesResponse.json() as { data?: { favoriteAppIds?: unknown } };
        const ids = new Set(normalizeFavoriteAppIds(saved.data?.favoriteAppIds));
        if (!controller.signal.aborted) {
          setFavorites({ status: "ready", apps: catalog.items.filter(app => app.canLaunch && ids.has(app.appId)) });
        }
      } catch {
        if (!controller.signal.aborted) setFavorites({ status: "error" });
      }
    };
    void load();
    return () => controller.abort();
  }, [activeTab]);

  return (
    <div data-testid="quick-start-section">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground [@media(max-height:800px)]:mb-2">
        Quick start
      </h2>
      <Tabs defaultValue={QUICK_START_TABS[0].id} onValueChange={(tab) => {
        setActiveTab(tab);
        if (tab === "favorites") setFavorites({ status: "loading" });
      }}>
        <TabsList
          className="home-quick-start-tabs"
          indicatorClassName="home-quick-start-indicator"
        >
          {QUICK_START_TABS.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id} data-testid={`quick-start-tab-${tab.id}`}>
              {tab.label}
            </TabsTrigger>
          ))}
          <TabsTrigger value="favorites" data-testid="quick-start-tab-favorites">Favorites</TabsTrigger>
        </TabsList>
        {QUICK_START_TABS.map((tab) => (
          <TabsContent key={tab.id} value={tab.id}>
            <div className="home-quick-start-panel rounded-xl border border-border/50 p-4 [@media(max-height:800px)]:p-3">
              <h3 className="mb-4 text-base font-semibold text-foreground [@media(max-height:800px)]:mb-3">
                {tab.label}
              </h3>
              <div
                className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 [@media(max-height:800px)]:gap-2"
                data-testid="quick-start-card-grid"
              >
                {tab.cards.map((card) => (
                  <QuickStartCard key={card.id} card={card} />
                ))}
              </div>
            </div>
          </TabsContent>
        ))}
        <TabsContent value="favorites">
          <div className="home-quick-start-panel rounded-xl border border-border/50 p-4 [@media(max-height:800px)]:p-3">
            <h3 className="mb-4 text-base font-semibold text-foreground">Favorite apps</h3>
            {favorites.status === "loading" || favorites.status === "idle" ? (
              <p role="status" className="text-sm text-muted-foreground">Loading favorite apps…</p>
            ) : favorites.status === "error" ? (
              <p role="alert" className="text-sm text-destructive">Favorite apps could not be loaded. Switch tabs to try again.</p>
            ) : favorites.apps.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No favorite apps yet. <NavigationProgressLink href="/apps" className="text-primary underline underline-offset-2">Star an app in Apps</NavigationProgressLink> to add it here.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5" aria-label="Favorite apps">
                {favorites.apps.map(app => <FavoriteAppCard key={app.appId} app={app} />)}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
