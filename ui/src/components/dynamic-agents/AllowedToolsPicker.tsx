"use client";

import { getErrorMessage } from "@/lib/error-utils";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
Tooltip,
TooltipContent,
TooltipProvider,
TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { MCPServerConfig,MCPToolInfo } from "@/types/dynamic-agent";
import {
AlertTriangle,
Check,
ChevronDown,
ChevronRight,
Info,
Loader2,
Search,
Server,
Zap,
} from "lucide-react";
import React from "react";

interface AllowedToolsPickerProps {
  value: Record<string, string[] | boolean>; // server_id -> tool names, true=all, false=disabled
  onChange: (value: Record<string, string[] | boolean>) => void;
  disabled?: boolean;
}

interface ProbeState {
  loading: boolean;
  tools?: MCPToolInfo[];
  error?: string;
}

export function AllowedToolsPicker({ value, onChange, disabled }: AllowedToolsPickerProps) {
  const [servers, setServers] = React.useState<MCPServerConfig[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [probeStates, setProbeStates] = React.useState<Record<string, ProbeState>>({});
  const [expandedServers, setExpandedServers] = React.useState<Set<string>>(new Set());
  const [searchQueries, setSearchQueries] = React.useState<Record<string, string>>({});
  const [missingTools, setMissingTools] = React.useState<Record<string, string[]>>({});
  const current = React.useRef({ value, onChange, disabled });
  const mounted = React.useRef(true);
  const probes = React.useRef(new Map<string, Promise<MCPToolInfo[] | undefined>>());
  React.useEffect(() => { current.current = { value, onChange, disabled }; }, [value, onChange, disabled]);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const updateValue = (next: AllowedToolsPickerProps["value"]) => {
    current.current.value = next;
    current.current.onChange(next);
  };

  // Compute total missing tools for warning banner
  const totalMissingTools = React.useMemo(() => {
    return Object.values(missingTools).flat().length;
  }, [missingTools]);

  // Fetch available MCP servers
  React.useEffect(() => {
    const fetchServers = async () => {
      setLoading(true);
      try {
        const response = await fetch("/api/mcp-servers?page_size=100", {
          credentials: "include",
        });
        const data = await response.json();
        if (data.success) {
          // Only show enabled servers
          setServers((data.data.items || []).filter((s: MCPServerConfig) => s.enabled));
        } else {
          setError(data.error || "Failed to fetch servers");
        }
      } catch (err) {
        setError(getErrorMessage(err, "") || "Failed to fetch servers");
      } finally {
        setLoading(false);
      }
    };
    fetchServers();
  }, []);

  const loadTools = async (serverId: string): Promise<MCPToolInfo[] | undefined> => {
    setProbeStates((prev) => ({
      ...prev,
      [serverId]: { loading: true },
    }));

    try {
      const response = await fetch(`/api/mcp-servers/probe?id=${encodeURIComponent(serverId)}&list_only=true`, {
        method: "POST",
        credentials: "include",
      });
      const data = await response.json();
      if (!mounted.current) return;
      if (response.ok && data.success) {
        if (data.data?.success === false) {
          setProbeStates((prev) => ({
            ...prev,
            [serverId]: {
              loading: false,
              error: data.data.error || "Probe failed",
            },
          }));
          return;
        }
        if (!Array.isArray(data.data?.tools) || data.data.tools.some(
          (tool: MCPToolInfo) => !tool || typeof tool.name !== "string" || !tool.name.trim() || tool.name === "*",
        )) {
          throw new Error("Server returned an invalid tool list");
        }
        const tools = data.data.tools as MCPToolInfo[];
        setProbeStates((prev) => ({
          ...prev,
          [serverId]: { loading: false, tools },
        }));
        
        // Detect missing tools - tools in config but not returned by probe
        const configuredTools = current.current.value[serverId];
        if (Array.isArray(configuredTools) && configuredTools.length > 0) {
          const availableToolNames = new Set(tools.map((t) => t.name));
          const missing = configuredTools.filter((t) => !availableToolNames.has(t));
          if (missing.length > 0) {
            setMissingTools((prev) => ({ ...prev, [serverId]: missing }));
          } else {
            // Clear any previous missing tools for this server
            setMissingTools((prev) => {
              const newMissing = { ...prev };
              delete newMissing[serverId];
              return newMissing;
            });
          }
        }
        
        // Auto-expand after successful probe
        setExpandedServers((prev) => new Set([...prev, serverId]));
        return tools;
      } else {
        setProbeStates((prev) => ({
          ...prev,
          [serverId]: { loading: false, error: data.error || "Probe failed" },
        }));
      }
    } catch (err) {
      if (!mounted.current) return;
      setProbeStates((prev) => ({
        ...prev,
        [serverId]: { loading: false, error: getErrorMessage(err, "") || "Probe failed" },
      }));
    }
  };

  const handleProbe = (serverId: string) => {
    const pending = probes.current.get(serverId);
    if (pending) return pending;
    const request = loadTools(serverId).finally(() => { probes.current.delete(serverId); });
    probes.current.set(serverId, request);
    return request;
  };

  const isServerSelected = (serverId: string) => {
    return serverId in value && value[serverId] !== false;
  };

  const isToolSelected = (serverId: string, toolName: string) => {
    if (!isServerSelected(serverId)) return false;
    const tools = value[serverId];
    // true or empty array means all tools
    if (tools === true || (Array.isArray(tools) && tools.length === 0)) return true;
    return Array.isArray(tools) && tools.includes(toolName);
  };

  const isAllToolsSelected = (serverId: string) => {
    if (!isServerSelected(serverId)) return false;
    const tools = value[serverId];
    return tools === true || (Array.isArray(tools) && tools.length === 0);
  };

  const toggleServer = async (serverId: string) => {
    if (disabled) return;
    
    const newValue = { ...value };
    if (isServerSelected(serverId)) {
      delete newValue[serverId];
    } else {
      // Freeze the advertised catalog; future tools require an explicit grant.
      setExpandedServers((prev) => new Set([...prev, serverId]));
      const before = current.current.value[serverId];
      const tools = probeStates[serverId]?.tools ?? await handleProbe(serverId);
      if (!mounted.current || current.current.disabled || current.current.value[serverId] !== before) return;
      if (!tools?.length) return;
      updateValue({ ...current.current.value, [serverId]: [...new Set(tools.map((tool) => tool.name))] });
      return;
    }
    updateValue(newValue);
  };

  const toggleAllTools = (serverId: string) => {
    if (disabled || !isServerSelected(serverId)) return;
    
    const newValue = { ...value };
    const tools = probeStates[serverId]?.tools;
    if (!tools?.length) return;
    newValue[serverId] = [...new Set(tools.map((tool) => tool.name))];
    updateValue(newValue);
  };

  const toggleTool = (serverId: string, toolName: string) => {
    if (disabled) return;
    
    const newValue = { ...value };
    const probe = probeStates[serverId];
    const allTools = probe?.tools?.map((t) => t.name) || [];

    if (!isServerSelected(serverId)) {
      // First select the server with just this tool
      newValue[serverId] = [toolName];
    } else if (isAllToolsSelected(serverId)) {
      // Currently all tools selected, switch to all except this one
      const remaining = allTools.filter((t) => t !== toolName);
      if (remaining.length) newValue[serverId] = remaining;
      else delete newValue[serverId];
    } else {
      // Currently specific tools selected
      const currentTools = [...(Array.isArray(value[serverId]) ? value[serverId] as string[] : [])];
      if (currentTools.includes(toolName)) {
        // Remove tool
        const filtered = currentTools.filter((t) => t !== toolName);
        if (filtered.length === 0) {
          // No tools left, remove server
          delete newValue[serverId];
        } else {
          newValue[serverId] = filtered;
        }
      } else {
        // Add tool
        currentTools.push(toolName);
        newValue[serverId] = currentTools;
      }
    }
    updateValue(newValue);
  };

  const toggleExpanded = (serverId: string) => {
    if (!expandedServers.has(serverId) && !probeStates[serverId]?.tools) {
      void handleProbe(serverId);
    }
    setExpandedServers((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(serverId)) {
        newSet.delete(serverId);
      } else {
        newSet.add(serverId);
      }
      return newSet;
    });
  };

  const getSelectedToolsCount = (serverId: string) => {
    if (!isServerSelected(serverId)) return 0;
    const tools = value[serverId];
    if (tools === true || (Array.isArray(tools) && tools.length === 0)) {
      // All tools
      const probe = probeStates[serverId];
      return probe?.tools?.length || "all";
    }
    return Array.isArray(tools) ? tools.length : 0;
  };

  // Filter tools by search query
  const getFilteredTools = (serverId: string, tools: MCPToolInfo[]): MCPToolInfo[] => {
    const query = searchQueries[serverId]?.toLowerCase();
    if (!query) return tools;
    return tools.filter(
      (tool) =>
        tool.name.toLowerCase().includes(query) ||
        tool.description?.toLowerCase().includes(query)
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <div className="text-center py-8 border rounded-lg bg-muted/20">
        <Server className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">No MCP servers available</p>
        <p className="text-xs text-muted-foreground mt-1">
          Add MCP servers in the &quot;MCP Servers&quot; tab first
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Selecting a server selects its currently listed tools. New tools must be selected separately.
      </p>
      {/* Warning banner for missing tools */}
      {totalMissingTools > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 mb-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <p className="text-sm text-amber-600 dark:text-amber-400">
              Some configured tools are no longer available on their servers. They will be skipped at runtime.
            </p>
          </div>
        </div>
      )}

      {servers.map((server) => {
        const probe = probeStates[server._id];
        const isSelected = isServerSelected(server._id);
        const isExpanded = expandedServers.has(server._id);
        const toolsCount = getSelectedToolsCount(server._id);
        const filteredTools = probe?.tools ? getFilteredTools(server._id, probe.tools) : [];
        const showSearch = probe?.tools && probe.tools.length > 5;

        return (
          <div
            key={server._id}
            className={cn(
              "border rounded-lg transition-colors",
              isSelected ? "border-primary bg-primary/5" : "border-border"
            )}
          >
            {/* Server Header Row */}
            <div className="flex items-center justify-between p-3">
              <div className="flex items-center gap-2">
                {/* Checkbox */}
                <button
                  type="button"
                  onClick={() => toggleServer(server._id)}
                  aria-label={`Select tools from ${server.name}`}
                  aria-pressed={isSelected}
                  disabled={disabled || probe?.loading}
                  className={cn(
                    "h-4 w-4 rounded border flex items-center justify-center transition-colors flex-shrink-0",
                    isSelected
                      ? "bg-primary border-primary text-primary-foreground"
                      : "border-muted-foreground/30 hover:border-primary"
                  )}
                >
                  {isSelected && <Check className="h-2.5 w-2.5" />}
                </button>

                {/* Expand/Collapse */}
                <button
                  type="button"
                  onClick={() => toggleExpanded(server._id)}
                  className="flex flex-col items-start"
                >
                  <div className="flex items-center gap-2">
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                    <Server className="h-4 w-4 text-blue-500" />
                    <span className="font-medium text-sm">{server.name}</span>
                  </div>
                  {/* Show loading indicator when probing */}
                  {probe?.loading && (
                    <span className="text-xs text-muted-foreground ml-6 flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Refreshing tool list...
                    </span>
                  )}
                </button>
              </div>

              <div className="flex items-center gap-2">
                {isSelected && (
                  <Badge variant="secondary" className="text-xs">
                    {toolsCount === "all" ? "All" : toolsCount}
                  </Badge>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleProbe(server._id)}
                  disabled={probe?.loading}
                  className="h-7 px-2"
                >
                  {probe?.loading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <>
                      <Zap className="h-3 w-3 mr-1" />
                      <span className="text-xs">Probe</span>
                    </>
                  )}
                </Button>
              </div>
            </div>

            {/* Expanded Content */}
            {isExpanded && (
              <div className="border-t px-3 pb-3 pt-2">
                {probe?.error ? (
                  <p className="text-xs text-destructive">{probe.error}</p>
                ) : probe?.tools && probe.tools.length > 0 ? (
                  <div className="space-y-2">
                    {/* Search and "Select All" row */}
                    <div className="flex items-center justify-between gap-2">
                      {showSearch ? (
                        <div className="relative flex-1">
                          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                          <Input
                            placeholder="Search tools..."
                            value={searchQueries[server._id] || ""}
                            onChange={(e) =>
                              setSearchQueries((prev) => ({
                                ...prev,
                                [server._id]: e.target.value,
                              }))
                            }
                            className="h-7 text-xs pl-7"
                          />
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {probe.tools.length} tools
                        </span>
                      )}
                      {isSelected && (
                        <button
                          type="button"
                          onClick={() => toggleAllTools(server._id)}
                          disabled={disabled}
                          className="text-xs text-primary hover:underline whitespace-nowrap"
                        >
                          Select all listed tools
                        </button>
                      )}
                    </div>

                    {/* Tool Grid - 2 columns */}
                    <div className="grid grid-cols-2 gap-1">
                      {filteredTools.map((tool) => {
                        const selected = isToolSelected(server._id, tool.name);
                        const isMissing = missingTools[server._id]?.includes(tool.name);
                        return (
                          <div
                            key={tool.namespaced_name}
                            className={cn(
                              "flex items-start gap-1.5 p-1.5 rounded text-left transition-colors text-xs",
                              selected && !isMissing && "bg-primary/10 border border-primary/30",
                              selected && isMissing && "bg-amber-500/10 border border-amber-500/30",
                              !selected && "bg-muted/30 hover:bg-muted/50 border border-transparent"
                            )}
                          >
                            {/* Checkbox */}
                            <button
                              type="button"
                              onClick={() => toggleTool(server._id, tool.name)}
                              aria-label={`Select ${tool.name}`}
                              aria-pressed={selected}
                              disabled={disabled}
                              className={cn(
                                "h-3 w-3 rounded border flex items-center justify-center flex-shrink-0 mt-0.5",
                                selected
                                  ? "bg-primary border-primary text-primary-foreground"
                                  : "border-muted-foreground/30"
                              )}
                            >
                              {selected && <Check className="h-2 w-2" />}
                            </button>
                            
                            {/* Tool name and description */}
                            <button
                              type="button"
                              onClick={() => toggleTool(server._id, tool.name)}
                              disabled={disabled}
                              className="flex-1 min-w-0 text-left"
                            >
                              <span className="font-mono truncate block flex items-center gap-1">
                                {isMissing && <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />}
                                {tool.name}
                              </span>
                              <span className="text-[10px] text-muted-foreground truncate block">
                                {isMissing ? "Tool not found on server" : (tool.description || "")}
                              </span>
                            </button>

                            {/* Info tooltip for full description */}
                            {tool.description && !isMissing && (
                              <TooltipProvider delayDuration={200}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      onClick={(e) => e.stopPropagation()}
                                      className="flex-shrink-0 text-muted-foreground hover:text-foreground mt-0.5"
                                    >
                                      <Info className="h-3 w-3" />
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-xs whitespace-normal">
                                    <p className="text-xs">{tool.description}</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                          </div>
                        );
                      })}

                      {/* Render missing tools that aren't in the probe results */}
                      {missingTools[server._id]?.filter(
                        (toolName) => !filteredTools.find((t) => t.name === toolName)
                      ).map((toolName) => {
                        const selected = isToolSelected(server._id, toolName);
                        return (
                          <div
                            key={`missing-${toolName}`}
                            className="flex items-start gap-1.5 p-1.5 rounded text-left transition-colors text-xs bg-amber-500/10 border border-amber-500/30"
                          >
                            {/* Checkbox */}
                            <button
                              type="button"
                              onClick={() => toggleTool(server._id, toolName)}
                              disabled={disabled}
                              className={cn(
                                "h-3 w-3 rounded border flex items-center justify-center flex-shrink-0 mt-0.5",
                                selected
                                  ? "bg-primary border-primary text-primary-foreground"
                                  : "border-muted-foreground/30"
                              )}
                            >
                              {selected && <Check className="h-2 w-2" />}
                            </button>
                            
                            {/* Tool name and description */}
                            <button
                              type="button"
                              onClick={() => toggleTool(server._id, toolName)}
                              disabled={disabled}
                              className="flex-1 min-w-0 text-left"
                            >
                              <span className="font-mono truncate block flex items-center gap-1">
                                <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
                                {toolName}
                              </span>
                              <span className="text-[10px] text-amber-600 dark:text-amber-400 truncate block">
                                Tool not found on server
                              </span>
                            </button>
                          </div>
                        );
                      })}
                    </div>

                    {/* No results message */}
                    {filteredTools.length === 0 && searchQueries[server._id] && (
                      <p className="text-xs text-muted-foreground text-center py-2">
                        No tools match &quot;{searchQueries[server._id]}&quot;
                      </p>
                    )}
                  </div>
                ) : probe?.tools && probe.tools.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No tools found</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Click &quot;Probe&quot; to discover tools
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
