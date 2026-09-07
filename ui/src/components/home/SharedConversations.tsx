"use client";

import { apiClient } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { Conversation as MongoConversation } from "@/types/mongodb";
import { Users, Users2 } from "lucide-react";
import { useSession } from "next-auth/react";
import React, { useEffect, useState } from "react";
import { ConversationCard } from "./ConversationCard";

type TabId = "shared-with-me" | "team";

interface SharedConversation {
  id: string;
  title: string;
  updatedAt: Date | string;
  totalMessages?: number;
  sharedBy?: string;
  teamName?: string;
}

function mapSharedConversation(conv: MongoConversation): SharedConversation {
  return {
    id: conv._id,
    title: conv.title,
    updatedAt: conv.updated_at,
    totalMessages: conv.metadata?.total_messages,
    sharedBy: conv.owner_id,
  };
}

const tabs: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: "shared-with-me", label: "Shared with me", icon: Users2 },
  { id: "team", label: "Team", icon: Users },
];

interface SharedConversationsProps {
  compact?: boolean;
}

export function SharedConversations({ compact = false }: SharedConversationsProps = {}) {
  const { status } = useSession();
  const isAuthenticated = status === "authenticated";
  const [activeTab, setActiveTab] = useState<TabId>("shared-with-me");
  const [sharedWithMe, setSharedWithMe] = useState<SharedConversation[]>([]);
  const [sharedWithTeam, setSharedWithTeam] = useState<SharedConversation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }

    const load = async () => {
      setLoading(true);
      try {
        const response = await apiClient.getSharedConversations({ page_size: 20 });
        const all = response.items.map(mapSharedConversation);
        setSharedWithMe(all);
        setSharedWithTeam(
          response.items
            .filter((c) => (c.sharing?.shared_with_teams?.length ?? 0) > 0)
            .map(mapSharedConversation),
        );
      } catch (err) {
        console.error("[SharedConversations] Failed to load shared conversations:", err);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [isAuthenticated]);

  const getActiveItems = (): SharedConversation[] => {
    switch (activeTab) {
      case "shared-with-me":
        return sharedWithMe;
      case "team":
        return sharedWithTeam;
      default:
        return [];
    }
  };

  const getEmptyMessage = (): string => {
    switch (activeTab) {
      case "shared-with-me":
        return "No conversations shared with you yet.";
      case "team":
        return "No team-shared conversations yet.";
      default:
        return "No conversations found.";
    }
  };

  const activeItems = getActiveItems();
  const gridClassName = compact
    ? "grid grid-cols-1 gap-3 xl:grid-cols-2"
    : "grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3";

  return (
    <div data-testid="shared-conversations">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
        Shared Conversations
      </h2>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4 bg-muted/30 rounded-lg p-1 w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            data-testid={`shared-tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
              activeTab === tab.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <tab.icon className="h-3.5 w-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className={gridClassName}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              data-testid="skeleton"
              className="h-24 rounded-lg bg-muted/30 animate-pulse"
            />
          ))}
        </div>
      ) : activeItems.length === 0 ? (
        <div
          data-testid="shared-empty"
          className="flex flex-col items-center justify-center py-8 text-center"
        >
          <div className="h-12 w-12 rounded-full bg-muted/50 flex items-center justify-center mb-3">
            <Users2 className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">{getEmptyMessage()}</p>
        </div>
      ) : (
        <div className={gridClassName}>
          {activeItems.map((conv) => (
            <ConversationCard
              key={conv.id}
              id={conv.id}
              title={conv.title}
              updatedAt={conv.updatedAt}
              totalMessages={conv.totalMessages}
              isShared
              sharedBy={conv.sharedBy}
              teamName={conv.teamName}
            />
          ))}
        </div>
      )}
    </div>
  );
}
