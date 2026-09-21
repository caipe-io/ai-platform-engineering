"use client";

import { Tabs,TabsContent,TabsList,TabsTrigger } from "@/components/ui/tabs";
import { QUICK_START_TABS } from "./quickStartCards";
import { QuickStartCard } from "./QuickStartCard";

export function QuickStartSection() {
  return (
    <div data-testid="quick-start-section">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground [@media(max-height:800px)]:mb-2">
        Quick start
      </h2>
      <Tabs defaultValue={QUICK_START_TABS[0].id}>
        <TabsList
          className="home-quick-start-tabs"
          indicatorClassName="home-quick-start-indicator"
        >
          {QUICK_START_TABS.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id} data-testid={`quick-start-tab-${tab.id}`}>
              {tab.label}
            </TabsTrigger>
          ))}
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
      </Tabs>
    </div>
  );
}
