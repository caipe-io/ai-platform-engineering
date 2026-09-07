"use client";

import { cn,formatRelativeTimeCompact } from "@/lib/utils";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import { Bot,Clock,MessageSquare,Users2 } from "lucide-react";

interface ConversationCardProps {
  id: string;
  title: string;
  updatedAt: Date | string;
  totalMessages?: number;
  agentName?: string;
  isShared?: boolean;
  sharedBy?: string;
  teamName?: string;
}

export function ConversationCard({
  id,
  title,
  updatedAt,
  totalMessages,
  agentName,
  isShared,
  sharedBy,
  teamName,
}: ConversationCardProps) {
  return (
    <NavigationProgressLink
      href={`/chat/${id}`}
      data-testid={`conversation-card-${id}`}
      className={cn(
        "group block p-4 rounded-lg border border-border/50 bg-card/50",
        "hover:border-primary/30 hover:bg-card/80 transition-all",
        "cursor-pointer"
      )}
    >
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 group-hover:bg-primary/20 transition-colors">
          <MessageSquare className="h-4 w-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium truncate text-foreground group-hover:text-primary transition-colors">
            {title || "Untitled Conversation"}
          </h4>
          <div className="flex items-center gap-2 mt-1.5">
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              {formatRelativeTimeCompact(updatedAt)}
            </span>
            {totalMessages != null && totalMessages > 0 && (
              <span className="text-xs text-muted-foreground">
                {totalMessages} {totalMessages === 1 ? "message" : "messages"}
              </span>
            )}
          </div>
          {agentName && (
            <div className="flex items-center gap-1 mt-1.5 text-xs text-primary/90 min-w-0">
              <Bot className="h-3 w-3 shrink-0" />
              <span className="truncate" title={agentName}>
                {agentName}
              </span>
            </div>
          )}
          {isShared && (
            <div className="flex items-center gap-1 mt-1.5">
              <Users2 className="h-3 w-3 text-blue-400" />
              <span className="text-xs text-blue-400">
                {teamName
                  ? `Shared with ${teamName}`
                  : sharedBy
                  ? `Shared by ${sharedBy}`
                  : "Shared"}
              </span>
            </div>
          )}
        </div>
      </div>
    </NavigationProgressLink>
  );
}
