import { CapabilityCards } from "./CapabilityCards";
import { HeroComposer } from "./HeroComposer";
import { InsightsWidget } from "./InsightsWidget";
import { QuickStartSection } from "./QuickStart/QuickStartSection";
import { RecentChats } from "./RecentChats";
import { SharedConversations } from "./SharedConversations";
import type { ComponentType } from "react";

/** Maps each `HOME_WIDGET_DEFINITIONS` id to its zero-required-prop component. */
export const HOME_WIDGET_COMPONENTS: Record<string, ComponentType> = {
  heroComposer: HeroComposer,
  quickStart: QuickStartSection,
  shortcuts: CapabilityCards,
  recentChats: () => <RecentChats compact maxItems={4} />,
  insights: InsightsWidget,
  sharedConversations: () => <SharedConversations compact />,
};
