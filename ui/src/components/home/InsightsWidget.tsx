"use client";

import {
ArrowRight,
Bot,
MessageSquare,
TrendingUp,
} from "lucide-react";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import { apiClient } from "@/lib/api-client";
import type { UserStats } from "@/types/mongodb";
import { useSession } from "next-auth/react";
import { useEffect,useState } from "react";

export function InsightsWidget() {
  const { status } = useSession();
  const isAuthenticated = status === "authenticated";
  const [stats, setStats] = useState<UserStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }

    const load = async () => {
      setLoading(true);
      try {
        setStats(await apiClient.getUserStats());
      } catch (err) {
        console.error("[InsightsWidget] Failed to load user stats:", err);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [isAuthenticated]);

  return (
    <div data-testid="insights-widget">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Your Insights
        </h3>
        <NavigationProgressLink
          href="/insights"
          data-testid="view-all-insights"
          className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
        >
          View all
          <ArrowRight className="h-3 w-3" />
        </NavigationProgressLink>
      </div>

      {loading ? (
        <div data-testid="insights-widget-loading" className="p-4 rounded-lg border border-border/50 bg-card/50 space-y-3">
          <div className="h-8 w-16 bg-muted/30 animate-pulse rounded" />
          <div className="h-4 w-32 bg-muted/30 animate-pulse rounded" />
        </div>
      ) : !stats ? (
        <div data-testid="insights-widget-empty" className="p-4 rounded-lg border border-border/50 bg-card/50">
          <p className="text-sm text-muted-foreground">
            Start chatting to build your insights.
          </p>
        </div>
      ) : (
        <div className="p-4 rounded-lg border border-border/50 bg-card/50 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <MessageSquare className="h-3.5 w-3.5" />
                <span className="text-xs">Conversations</span>
              </div>
              <p className="text-xl font-bold text-foreground" data-testid="total-conversations">
                {stats.total_conversations}
              </p>
              <p className="text-xs text-muted-foreground" data-testid="conversations-this-week">
                {stats.conversations_this_week} this week
              </p>
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <TrendingUp className="h-3.5 w-3.5" />
                <span className="text-xs">Messages</span>
              </div>
              <p className="text-xl font-bold text-foreground" data-testid="messages-this-week-value">
                {stats.messages_this_week}
              </p>
              <p className="text-xs text-muted-foreground">this week</p>
            </div>
          </div>

          {stats.favorite_agents.slice(0, 3).length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-muted-foreground mb-2">
                <Bot className="h-3.5 w-3.5" />
                <span className="text-xs">Top Agents</span>
              </div>
              <div className="space-y-1.5">
                {stats.favorite_agents.slice(0, 3).map((agent) => (
                  <div key={agent.name} className="flex items-center justify-between">
                    <span className="text-xs text-foreground capitalize" data-testid={`agent-${agent.name}`}>
                      {agent.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {agent.count} {agent.count === 1 ? "use" : "uses"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
