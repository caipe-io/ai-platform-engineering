"use client";

// assisted-by Codex Codex-sonnet-4-6

import { cn } from "@/lib/utils";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import { config } from "@/lib/config";
import { ArrowRight,Bot,Database,MessageSquare,Server,Workflow,Zap } from "lucide-react";

const capabilities = [
  {
    id: "chat",
    title: "Chat",
    description: "Ask agents questions, troubleshoot issues, and get work done.",
    icon: MessageSquare,
    href: "/chat",
    color: "text-blue-400",
    bgColor: "bg-blue-500/10",
    borderColor: "hover:border-blue-500/30",
  },
  {
    id: "agents",
    title: "Agents",
    description: "Build AI agents with the models, skills, and tools your team needs.",
    icon: Bot,
    href: "/dynamic-agents",
    color: "text-cyan-400",
    bgColor: "bg-cyan-500/10",
    borderColor: "hover:border-cyan-500/30",
  },
  {
    id: "mcp-servers",
    title: "Tools",
    description: "Connect agents to APIs, infrastructure, and internal services.",
    icon: Server,
    href: "/dynamic-agents?tab=mcp-servers",
    color: "text-teal-400",
    bgColor: "bg-teal-500/10",
    borderColor: "hover:border-teal-500/30",
  },
  {
    id: "skills",
    title: "Skills",
    description: "Discover reusable skills and templates for common tasks.",
    icon: Zap,
    href: "/skills",
    color: "text-amber-400",
    bgColor: "bg-amber-500/10",
    borderColor: "hover:border-amber-500/30",
  },
  {
    id: "workflows",
    title: "Workflows",
    description: "Automate repeatable, multi-step work across your tools.",
    icon: Workflow,
    href: "/workflows",
    color: "text-violet-400",
    bgColor: "bg-violet-500/10",
    borderColor: "hover:border-violet-500/30",
  },
  {
    id: "knowledge-bases",
    title: "Knowledge Bases",
    description: "Search trusted organizational knowledge and data sources.",
    icon: Database,
    href: "/knowledge-bases/search",
    color: "text-emerald-400",
    bgColor: "bg-emerald-500/10",
    borderColor: "hover:border-emerald-500/30",
    requiresRag: true,
  },
];

export function CapabilityCards() {
  const visibleCapabilities = capabilities.filter(
    (c) => !c.requiresRag || config.ragEnabled
  );

  return (
    <div data-testid="capability-cards">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
        Start Here
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {visibleCapabilities.map((cap) => (
          <NavigationProgressLink
            key={cap.id}
            href={cap.href}
            data-testid={`capability-card-${cap.id}`}
            className={cn(
              "group block p-5 rounded-lg border border-border/50 bg-card/50",
              "hover:bg-card/80 transition-all",
              cap.borderColor
            )}
          >
            <div className="flex items-start gap-3">
              <div
                className={cn(
                  "h-10 w-10 rounded-lg flex items-center justify-center shrink-0",
                  cap.bgColor
                )}
              >
                <cap.icon className={cn("h-5 w-5", cap.color)} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    {cap.title}
                  </h3>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                  {cap.description}
                </p>
              </div>
            </div>
          </NavigationProgressLink>
        ))}
      </div>
    </div>
  );
}
