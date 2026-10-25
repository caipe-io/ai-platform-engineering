"use client";

import { AgentHarnessBadge } from "@/components/chat/AgentHarnessBadge";
import { Tooltip,TooltipContent,TooltipProvider,TooltipTrigger } from "@/components/ui/tooltip";
import { getAgentPresentation } from "@/lib/agent-presentation";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { Bot,Check,ChevronDown,Loader2,Lock,Search } from "lucide-react";
import React from "react";

export interface AgentPickerProps {
  selectedAgentId?: string;
  onSelectAgent: (agentId: string) => void;
  disabled?: boolean;
}

interface AgentOption {
  id: string;
  name: string;
  description?: string;
  harnessId?: string;
  presentation?: DynamicAgentConfig["presentation"];
}

/**
 * Harness-neutral picker for every chat-capable agent.
 *
 * The backing endpoint and document IDs intentionally remain unchanged so
 * legacy Dynamic Agents continue to resolve exactly as before. App identity
 * comes from the server-resolved installation binding, independently of harness.
 */
export function AgentPicker({ selectedAgentId, onSelectAgent, disabled }: AgentPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [agents, setAgents] = React.useState<DynamicAgentConfig[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [searchQuery, setSearchQuery] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Fetch available agents
  React.useEffect(() => {
    const fetchAgents = async () => {
      setLoading(true);
      try {
        const response = await fetch("/api/dynamic-agents/available");
        const data = await response.json();
        if (data.success) {
          setAgents(data.data || []);
        } else {
          setError(data.error || "Failed to fetch agents");
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to fetch agents";
        setError(message);
      } finally {
        setLoading(false);
      }
    };
    fetchAgents();
  }, []);

  // Close on click outside
  React.useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearchQuery("");
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setSearchQuery("");
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  // Build options list
  const options: AgentOption[] = React.useMemo(() => {
    return agents.map((agent) => ({
      id: agent._id,
      name: agent.name,
      description: agent.description,
      harnessId: agent.execution_harness_id,
      presentation: agent.presentation,
    }));
  }, [agents]);

  const filteredOptions = React.useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    if (!normalizedQuery) return options;

    return options.filter((option) => {
      const identity = getAgentPresentation(option.harnessId, option.presentation);
      return [
        option.name,
        option.description,
        ...identity.searchTerms,
      ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [options,searchQuery]);

  // Find currently selected option
  const selectedOption = options.find((opt) => opt.id === selectedAgentId) || options[0];

  const handleSelect = (optionId: string) => {
    onSelectAgent(optionId);
    setOpen(false);
    setSearchQuery("");
  };

  const handleToggle = () => {
    if (disabled) return;
    setOpen((isOpen) => {
      if (isOpen) setSearchQuery("");
      return !isOpen;
    });
  };

  // Don't show if no chat-capable agents are available.
  if (!loading && agents.length === 0) {
    return null;
  }

  return (
    <div ref={containerRef} className="relative inline-flex">
      {/* Trigger button */}
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={
                selectedOption
                  ? `Choose agent. Current agent: ${selectedOption.name}`
                  : "Choose agent"
              }
              onClick={handleToggle}
              disabled={loading}
              className={`inline-flex items-center justify-center whitespace-nowrap text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background rounded-md px-3 gap-2 min-h-8 ${
                disabled
                  ? "cursor-default opacity-70"
                  : "hover:bg-accent hover:text-accent-foreground cursor-pointer"
              }`}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Bot className="h-4 w-4" />
                  <span className="max-w-[150px] truncate">{selectedOption?.name}</span>
                  {selectedOption && (
                    <AgentHarnessBadge
                      compact
                      harnessId={selectedOption.harnessId}
                      presentation={selectedOption.presentation}
                    />
                  )}
                  {disabled ? (
                    <Lock className="h-3 w-3 opacity-50" />
                  ) : (
                    <ChevronDown className="h-3 w-3 opacity-50" />
                  )}
                </>
              )}
            </button>
          </TooltipTrigger>
          {disabled && (
            <TooltipContent side="bottom" sideOffset={8}>
              <p className="text-xs">Agent is locked for this conversation</p>
            </TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>

      {/* Dropdown - only show when open and not disabled */}
      {open && !disabled && (
        <div
          className="absolute top-full left-0 mt-2 z-50 w-80 rounded-lg bg-popover text-popover-foreground shadow-lg border border-border animate-in fade-in-0 zoom-in-95 slide-in-from-top-2"
        >
          <div className="border-b border-border p-2">
            <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              Choose an agent
            </p>
            <label className="relative block">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                type="search"
                autoFocus
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search agents or harnesses"
                aria-label="Search agents or harnesses"
                className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          </div>
          <div className="max-h-64 space-y-1 overflow-y-auto p-1">
            {error ? (
              <p className="px-2 py-2 text-sm text-destructive">{error}</p>
            ) : filteredOptions.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No agents match your search.
              </p>
            ) : (
              filteredOptions.map((option) => {
                const isSelected = option.id === selectedOption?.id;

                return (
                  <button
                    key={option.id}
                    onClick={() => handleSelect(option.id)}
                    className={`w-full flex items-start gap-3 px-2 py-2 rounded-md text-left transition-colors ${
                      isSelected
                        ? "bg-primary/10 text-primary"
                        : "hover:bg-muted"
                    }`}
                  >
                    <div
                      className={`mt-0.5 h-4 w-4 rounded-full border flex items-center justify-center flex-shrink-0 ${
                        isSelected
                          ? "bg-primary border-primary text-primary-foreground"
                          : "border-muted-foreground/30"
                      }`}
                    >
                      {isSelected && <Check className="h-2.5 w-2.5" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <div className="truncate text-sm font-medium">{option.name}</div>
                        <AgentHarnessBadge compact harnessId={option.harnessId} presentation={option.presentation} />
                      </div>
                      {option.description && (
                        <div className="text-xs text-muted-foreground line-clamp-2">
                          {option.description}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Backward-compatible name used by existing Dynamic Agent chat surfaces.
 * New surfaces should prefer AgentPicker.
 */
export const AgentSelector = AgentPicker;
