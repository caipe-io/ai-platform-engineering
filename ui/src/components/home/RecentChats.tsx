"use client";

import { MessageSquare, Plus } from "lucide-react";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import { apiClient } from "@/lib/api-client";
import { getStorageMode } from "@/lib/storage-config";
import { useChatStore } from "@/store/chat-store";
import { getAgentId } from "@/types/a2a";
import type { Conversation as MongoConversation } from "@/types/mongodb";
import { useSession } from "next-auth/react";
import { useCallback,useEffect,useState } from "react";
import { ConversationCard } from "./ConversationCard";

interface HomeConversation {
  id: string;
  title: string;
  updatedAt: Date | string;
  totalMessages?: number;
  agentName?: string;
  isShared?: boolean;
}

interface RecentChatsProps {
  maxItems?: number;
  compact?: boolean;
}

export function RecentChats({ maxItems = 6, compact = false }: RecentChatsProps = {}) {
  const { status } = useSession();
  const isAuthenticated = status === "authenticated";
  const isMongoMode = getStorageMode() === "mongodb";
  const { conversations: localConversations, loadConversationsFromServer } = useChatStore();
  const [conversations, setConversations] = useState<HomeConversation[]>([]);
  const [loading, setLoading] = useState(true);

  const mapMongoConversation = useCallback((conv: MongoConversation): HomeConversation => {
    const enriched = conv as MongoConversation & {
      agent_id?: string;
      agent_name?: string;
      metadata?: MongoConversation["metadata"] & { agent_name?: string };
    };
    const agentId = enriched.agent_id ?? getAgentId(conv);

    return {
      id: conv._id,
      title: conv.title,
      updatedAt: conv.updated_at,
      totalMessages: conv.metadata?.total_messages,
      agentName: enriched.agent_name ?? enriched.metadata?.agent_name ?? agentId,
      isShared:
        (conv.sharing?.shared_with?.length ?? 0) > 0 ||
        (conv.sharing?.shared_with_teams?.length ?? 0) > 0,
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }

    const load = async () => {
      setLoading(true);
      try {
        if (isMongoMode) {
          const response = await apiClient.getConversations({ page_size: 8 });
          setConversations(response.items.map(mapMongoConversation));
        } else {
          await loadConversationsFromServer();
        }
      } catch (err) {
        console.error("[RecentChats] Failed to load recent chats:", err);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [isAuthenticated, isMongoMode, loadConversationsFromServer, mapMongoConversation]);

  useEffect(() => {
    if (!isAuthenticated || isMongoMode) return;
    const sorted = [...localConversations]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 8);
    setConversations(
      sorted.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        totalMessages: conversation.messages.length,
        agentName: getAgentId(conversation),
      })),
    );
    setLoading(false);
  }, [isAuthenticated, isMongoMode, localConversations]);

  const items = conversations.slice(0, maxItems);
  const gridClassName = compact
    ? "grid grid-cols-1 gap-3 xl:grid-cols-2"
    : "grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3";

  return (
    <div data-testid="recent-chats">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Recent Chats
        </h2>
        <NavigationProgressLink
          href="/chat"
          className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
          data-testid="new-chat-link"
        >
          <Plus className="h-3 w-3" />
          New Chat
        </NavigationProgressLink>
      </div>

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
      ) : items.length === 0 ? (
        <div
          data-testid="recent-chats-empty"
          className="flex flex-col items-center justify-center py-8 text-center"
        >
          <div className="h-12 w-12 rounded-full bg-muted/50 flex items-center justify-center mb-3">
            <MessageSquare className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground mb-2">
            No conversations yet
          </p>
          <NavigationProgressLink
            href="/chat"
            className="text-sm text-primary hover:underline"
          >
            Start a new chat
          </NavigationProgressLink>
        </div>
      ) : (
        <div className={gridClassName}>
          {items.map((conv) => (
            <ConversationCard
              key={conv.id}
              id={conv.id}
              title={conv.title}
              updatedAt={conv.updatedAt}
              totalMessages={conv.totalMessages}
              agentName={conv.agentName}
              isShared={conv.isShared}
            />
          ))}
        </div>
      )}
    </div>
  );
}
