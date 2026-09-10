"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card,CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
Tooltip,
TooltipContent,
TooltipProvider,
TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
AvailableSubagent,
CustomThemeConfig,
LegacyVisibilityType,
SubAgentRef,
VisibilityType,
} from "@/types/dynamic-agent";
import { AlertCircle,Bot,Globe,Loader2,Trash2,Users } from "lucide-react";
import React from "react";
import { AgentAvatar } from "./AgentAvatar";

// Loose shape for items returned by /api/dynamic-agents/available.
// We accept LegacyVisibilityType so docs that still carry visibility:"private"
// (until the migration script rewrites them) can be normalized on read.
interface RawAgentListItem {
  _id: string;
  name: string;
  description?: string;
  visibility?: LegacyVisibilityType;
  ui?: {
    gradient_theme?: string;
    custom_theme_config?: CustomThemeConfig;
  };
}

interface SubagentPickerProps {
  agentId: string | null; // null when creating new agent
  value: SubAgentRef[];
  onChange: (subagents: SubAgentRef[]) => void;
  disabled?: boolean;
  parentVisibility: VisibilityType;
}

/**
 * Get visibility compatibility status for a subagent.
 *
 * Rules (post `private` retirement, 2026-05-22):
 * - Team agent → can use team or global subagents
 * - Global agent → can only use global subagents
 *
 * Accepts LegacyVisibilityType for the subagent so docs that still carry
 * `visibility: "private"` (until the migration runs) are handled gracefully
 * rather than being treated as compatible.
 */
function getSubagentCompatibility(
  parentVisibility: VisibilityType,
  subagentVisibility: LegacyVisibilityType
): { compatible: boolean; reason?: string } {
  // Global parent can only use global subagents
  if (parentVisibility === "global" && subagentVisibility !== "global") {
    return {
      compatible: false,
      reason: "Global agents can only use global subagents",
    };
  }

  // Team parent can use team or global subagents
  if (
    parentVisibility === "team" &&
    subagentVisibility !== "team" &&
    subagentVisibility !== "global"
  ) {
    return {
      compatible: false,
      reason: "Team agents can only use team or global subagents",
    };
  }

  return { compatible: true };
}

const VISIBILITY_ICONS: Record<VisibilityType, React.ReactNode> = {
  team: <Users className="h-3 w-3" />,
  global: <Globe className="h-3 w-3" />,
};

export function SubagentPicker({ agentId, value, onChange, disabled, parentVisibility }: SubagentPickerProps) {
  const [availableAgents, setAvailableAgents] = React.useState<AvailableSubagent[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");

  // Fetch available subagents when agentId changes
  React.useEffect(() => {
    if (!agentId) {
      // For new agents, fetch all agents (they can be filtered later)
      fetchAllAgents();
    } else {
      fetchAvailableSubagents(agentId);
    }
  }, [agentId]);

  const fetchAllAgents = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/dynamic-agents/available");
      const data = await response.json();
      if (data.success && Array.isArray(data.data)) {
        setAvailableAgents(
          data.data.map((agent: RawAgentListItem) => ({
            id: agent._id,
            name: agent.name,
            description: agent.description,
            // Coerce any legacy 'private' read from the DB to 'team' so the
            // picker can still render. Missing visibility defaults to 'team'.
            visibility: agent.visibility === "global" ? "global" : "team",
            gradient_theme: agent.ui?.gradient_theme,
            custom_theme_config: agent.ui?.custom_theme_config,
          }))
        );
      }
    } catch {
      setError("Failed to load available agents");
    } finally {
      setLoading(false);
    }
  };

  const fetchAvailableSubagents = async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/dynamic-agents/available-subagents?id=${id}`);
      const data = await response.json();
      if (data.success && data.data?.agents) {
        setAvailableAgents(data.data.agents);
      } else {
        setError(data.error || "Failed to load available subagents");
      }
    } catch {
      setError("Failed to load available subagents");
    } finally {
      setLoading(false);
    }
  };

  const addSubagent = (agent: AvailableSubagent) => {
    // Check if already added
    if (value.some((s) => s.agent_id === agent.id)) {
      return;
    }

    // Generate a default routing name from the agent name
    const routingName = agent.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const newSubagent: SubAgentRef = {
      agent_id: agent.id,
      name: routingName,
      description: agent.description || `Delegate tasks to ${agent.name}`,
    };

    onChange([...value, newSubagent]);
  };

  const removeSubagent = (agentId: string) => {
    onChange(value.filter((s) => s.agent_id !== agentId));
  };

  const updateSubagent = (agentId: string, field: "name" | "description", newValue: string) => {
    onChange(
      value.map((s) => (s.agent_id === agentId ? { ...s, [field]: newValue } : s))
    );
  };

  // Get agent info by ID for display
  const getAgentInfo = (
    agentId: string,
  ): {
    name: string;
    visibility: VisibilityType;
    gradient_theme?: string;
    custom_theme_config?: CustomThemeConfig;
  } => {
    const agent = availableAgents.find((a) => a.id === agentId);
    return {
      name: agent?.name || agentId,
      visibility: agent?.visibility || "team",
      gradient_theme: agent?.gradient_theme,
      custom_theme_config: agent?.custom_theme_config,
    };
  };

  // Filter out already-added agents
  const selectableAgents = availableAgents.filter(
    (agent) => !value.some((s) => s.agent_id === agent.id)
  );

  const filteredAgents = selectableAgents.filter((agent) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      agent.name.toLowerCase().includes(q) ||
      (agent.description?.toLowerCase().includes(q) ?? false)
    );
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading available agents...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-destructive bg-destructive/10 rounded-lg">
        <AlertCircle className="h-4 w-4" />
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Visibility note */}
      <p className="text-xs text-muted-foreground">
        <span className="font-medium">Note:</span>{" "}Agents that don&apos;t have the same sharing permissions as this agent cannot be added, and are disabled.
      </p>

      {/* Currently configured subagents */}
      {value.length > 0 && (
        <div className="space-y-3">
          <Label>Configured Subagents</Label>
          {value.map((subagent) => {
            const agentInfo = getAgentInfo(subagent.agent_id);
            const { compatible, reason } = getSubagentCompatibility(parentVisibility, agentInfo.visibility);
            
            return (
              <Card 
                key={subagent.agent_id} 
                className={cn(
                  "border-primary/20",
                  !compatible && "border-destructive/50 bg-destructive/5"
                )}
              >
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 mt-1">
                      <AgentAvatar
                        agent={agentInfo}
                        rounded="rounded-md"
                        size="h-7 w-7"
                        iconSize="h-4 w-4"
                      />
                    </div>
                    <div className="flex-grow space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">
                            {agentInfo.name}
                          </span>
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            {VISIBILITY_ICONS[agentInfo.visibility]}
                            <span className="ml-1">{agentInfo.visibility}</span>
                          </Badge>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeSubagent(subagent.agent_id)}
                          disabled={disabled}
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>

                      {/* Incompatibility warning */}
                      {!compatible && reason && (
                        <div className="text-xs text-destructive bg-destructive/10 rounded px-2 py-1">
                          {reason}
                        </div>
                      )}

                      <div className="grid gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">
                            Routing Name
                          </Label>
                          <Input
                            value={subagent.name}
                            onChange={(e) =>
                              updateSubagent(subagent.agent_id, "name", e.target.value)
                            }
                            placeholder="e.g., code-reviewer"
                            disabled={disabled}
                            className="h-8 text-sm"
                          />
                          <p className="text-xs text-muted-foreground">
                            Identifier used when delegating tasks (e.g., &quot;code-reviewer&quot;)
                          </p>
                        </div>

                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">
                            Description for LLM
                          </Label>
                          <Input
                            value={subagent.description}
                            onChange={(e) =>
                              updateSubagent(subagent.agent_id, "description", e.target.value)
                            }
                            placeholder="e.g., Reviews code for bugs and best practices"
                            disabled={disabled}
                            className="h-8 text-sm"
                          />
                          <p className="text-xs text-muted-foreground">
                            The LLM uses this to decide when to delegate
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add subagent dropdown */}
      {selectableAgents.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Add Subagent</Label>
            <Input
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-7 text-xs w-1/4 mr-2"
            />
          </div>
          <div className="grid grid-cols-1 gap-1 max-h-72 overflow-y-auto overflow-x-hidden border rounded-lg p-2">
            <TooltipProvider>
              {filteredAgents.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-4">
                  No agents match &ldquo;{search}&rdquo;
                </div>
              ) : (
              filteredAgents.map((agent) => {
                const { compatible, reason } = getSubagentCompatibility(
                  parentVisibility,
                  agent.visibility
                );

                return (
                  <Tooltip key={agent.id}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => compatible && addSubagent(agent)}
                        disabled={disabled || !compatible}
                        className={cn(
                          "flex items-center gap-3 p-2 rounded-md text-left transition-colors w-full min-w-0",
                          compatible
                            ? "hover:bg-muted cursor-pointer"
                            : "opacity-50 cursor-not-allowed"
                        )}
                      >
                        <AgentAvatar
                          agent={agent}
                          rounded="rounded-md"
                          size="h-6 w-6"
                          iconSize="h-3.5 w-3.5"
                        />
                        <div className="flex-grow min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-medium text-sm truncate">{agent.name}</span>
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 flex-shrink-0">
                              {VISIBILITY_ICONS[agent.visibility]}
                              <span className="ml-1">{agent.visibility}</span>
                            </Badge>
                          </div>
                          {agent.description && (
                            <div className="text-xs text-muted-foreground truncate">
                              {agent.description}
                            </div>
                          )}
                        </div>
                      </button>
                    </TooltipTrigger>
                    {!compatible && reason && (
                      <TooltipContent>
                        <p>{reason}</p>
                      </TooltipContent>
                    )}
                  </Tooltip>
                );
              })
              )}
            </TooltipProvider>
          </div>
        </div>
      )}

      {/* Empty state */}
      {value.length === 0 && selectableAgents.length === 0 && (
        <div className="text-center p-8 text-muted-foreground border border-dashed rounded-lg">
          <Bot className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">
            {agentId
              ? "No other agents available for delegation"
              : "Create the agent first to configure subagents"}
          </p>
        </div>
      )}

      {/* Help text */}
      {value.length > 0 && (
        <p className="text-xs text-muted-foreground">
          When this agent runs, the LLM can delegate tasks to these subagents using the{" "}
          <code className="bg-muted px-1 py-0.5 rounded">task</code> tool.
        </p>
      )}
    </div>
  );
}
