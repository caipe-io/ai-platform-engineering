"use client";

import { AgentAvatar } from "@/components/dynamic-agents/AgentAvatar";
import { Button } from "@/components/ui/button";
import { resolveUsableChatAgent } from "@/lib/chat-agent-selection";
import { cn } from "@/lib/utils";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { ChevronDown,Loader2,Plus,Search } from "lucide-react";
import React,{ useEffect,useRef,useState } from "react";

interface NewChatButtonProps {
  collapsed: boolean;
  onNewChat: (agentId?: string) => void;
}

export function NewChatButton({ collapsed, onNewChat }: NewChatButtonProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [agents, setAgents] = useState<DynamicAgentConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [defaultAgentName, setDefaultAgentName] = useState<string>("New Chat");
  const [defaultAgentResolved, setDefaultAgentResolved] = useState(false);

  // Resolve the same usable agent as the Home composer: personal Web default,
  // platform default, then the first accessible agent. Keeping this selection
  // in one shared resolver prevents entry points from creating different chats.
  useEffect(() => {
    let cancelled = false;

    async function fetchDefaultAgent() {
      try {
        const agent = await resolveUsableChatAgent();

        if (cancelled) return;
        setDefaultAgentId(agent.id);
        setDefaultAgentName(agent.name);
      } catch {
        if (!cancelled) {
          setDefaultAgentId(null);
        }
      } finally {
        if (!cancelled) {
          setDefaultAgentResolved(true);
        }
      }
    }

    fetchDefaultAgent();

    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch available dynamic agents when dropdown opens
  useEffect(() => {
    if (!dropdownOpen) return;

    const fetchAgents = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/dynamic-agents/available");
        if (!response.ok) {
          throw new Error("Failed to fetch agents");
        }
        const data = await response.json();
        const fetched: DynamicAgentConfig[] = data.data || [];
        setAgents(fetched);
        // Update default agent display name now that we have the full list
        if (defaultAgentId) {
          const found = fetched.find((a) => a._id === defaultAgentId);
          if (found) setDefaultAgentName(found.name);
        }
      } catch (err) {
        console.error("Error fetching dynamic agents:", err);
        setError("Failed to load agents");
      } finally {
        setLoading(false);
      }
    };

    fetchAgents();
  }, [dropdownOpen, defaultAgentId]);

  // Close dropdown on click outside
  useEffect(() => {
    if (!dropdownOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };

    // Delay to prevent immediate close from trigger click
    setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);

    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [dropdownOpen]);

  // Close on escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dropdownOpen) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [dropdownOpen]);

  const handleMainClick = () => {
    // Route to the configured default agent (undefined → resolved downstream).
    onNewChat(defaultAgentId ?? undefined);
  };

  const handleDropdownToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDropdownOpen(!dropdownOpen);
    if (!dropdownOpen) setSearchQuery("");
  };

  const handleSelectAgent = (agentId?: string) => {
    setDropdownOpen(false);
    setSearchQuery("");
    onNewChat(agentId);
  };

  // Auto-focus search input when dropdown opens
  useEffect(() => {
    if (dropdownOpen && searchInputRef.current) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [dropdownOpen]);

  const query = searchQuery.toLowerCase();
  const filteredAgents = agents.filter(
    (a) =>
      a.name.toLowerCase().includes(query) ||
      (a.description?.toLowerCase().includes(query) ?? false)
  );

  // Collapsed mode: simple button without dropdown
  if (collapsed) {
    return (
      <Button
        onClick={handleMainClick}
        disabled={!defaultAgentResolved}
        className="w-full px-2 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 hover-glow"
        variant="ghost"
        size="icon"
      >
        <Plus className="h-4 w-4 shrink-0" />
      </Button>
    );
  }

  // Split button: main area + dropdown trigger
  return (
    <div className="relative w-full" ref={dropdownRef}>
      <div className="flex w-full">
        {/* Main button area */}
        <Button
          onClick={handleMainClick}
          disabled={!defaultAgentResolved}
          className={cn(
            "flex-1 gap-2 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 hover-glow",
            "rounded-r-none border-r-0"
          )}
          variant="ghost"
          size="default"
        >
          <Plus className="h-4 w-4 shrink-0" />
          <span className="whitespace-nowrap">{defaultAgentName}</span>
        </Button>

        {/* Dropdown trigger */}
        <Button
          onClick={handleDropdownToggle}
          className={cn(
            "px-2 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 hover-glow",
            "rounded-l-none",
            dropdownOpen && "bg-primary/20"
          )}
          variant="ghost"
          size="default"
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              dropdownOpen && "rotate-180"
            )}
          />
        </Button>
      </div>

      {/* Dropdown menu */}
      {dropdownOpen && (
        <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-md bg-popover border border-border shadow-lg animate-in fade-in-0 zoom-in-95 slide-in-from-top-2">
          {/* Search input */}
          <div className="px-2 pt-2 pb-1">
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-muted/50 border border-border/50">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search agents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
          </div>

          {/* Scrollable agent list */}
          <div className="overflow-y-auto max-h-96 py-1">
            {/* Loading state */}
            {loading && (
              <div className="flex items-center justify-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading agents...</span>
              </div>
            )}

            {/* Error state */}
            {error && !loading && (
              <div className="px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            {/* Dynamic agents list */}
            {!loading && !error && filteredAgents.map((agent) => {
              return (
                <button
                  key={agent._id}
                  onClick={() => handleSelectAgent(agent._id)}
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-accent transition-colors text-left"
                >
                  <AgentAvatar
                    agent={agent}
                    rounded="rounded-full"
                    size="w-8 h-8"
                    iconSize="h-4 w-4"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{agent.name}</div>
                    {agent.description && (
                      <div className="text-xs text-muted-foreground truncate">
                        {agent.description}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}

            {/* No results */}
            {!loading && !error && filteredAgents.length === 0 && (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                No agents match &quot;{searchQuery}&quot;
              </div>
            )}

            {/* No dynamic agents (and no search active) */}
            {!loading && !error && !searchQuery && agents.length === 0 && (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                No custom agents configured
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
