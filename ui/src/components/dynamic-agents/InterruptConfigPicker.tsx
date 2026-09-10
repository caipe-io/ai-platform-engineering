"use client";

import { Button } from "@/components/ui/button";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import { Tooltip,TooltipContent,TooltipProvider,TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { BuiltinToolsConfig,DecisionType,InterruptOn,InterruptToolConfig } from "@/types/dynamic-agent";
import { AlertTriangle,Info,Plus,Settings2,Trash2 } from "lucide-react";
import React from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface InterruptRow {
  id: string;
  namespace: string;
  tool: string;
  mode: "default" | "custom";
  allowed_decisions: DecisionType[];
}

interface InterruptConfigPickerProps {
  value: InterruptOn;
  onChange: (value: InterruptOn) => void;
  allowedTools: Record<string, string[] | boolean>;
  builtinTools?: BuiltinToolsConfig;
  disabled?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ALL_DECISIONS: DecisionType[] = ["approve", "edit", "reject"];

let rowIdCounter = 0;
function nextRowId(): string {
  return `interrupt-row-${++rowIdCounter}`;
}

/** Convert InterruptOn config to flat rows for editing. */
function configToRows(config: InterruptOn): InterruptRow[] {
  const rows: InterruptRow[] = [];
  for (const [namespace, tools] of Object.entries(config)) {
    for (const [tool, cfg] of Object.entries(tools)) {
      const isCustom = typeof cfg === "object" && cfg !== null;
      rows.push({
        id: nextRowId(),
        namespace,
        tool,
        mode: isCustom ? "custom" : "default",
        allowed_decisions: isCustom
          ? (cfg as InterruptToolConfig).allowed_decisions
          : [...ALL_DECISIONS],
      });
    }
  }
  return rows;
}

/** Convert rows back to InterruptOn config. */
function rowsToConfig(rows: InterruptRow[]): InterruptOn {
  const config: InterruptOn = {};
  for (const row of rows) {
    if (!config[row.namespace]) {
      config[row.namespace] = {};
    }
    if (row.mode === "default") {
      config[row.namespace][row.tool] = true;
    } else {
      config[row.namespace][row.tool] = { allowed_decisions: row.allowed_decisions };
    }
  }
  return config;
}

/** Get available tool names for a namespace (excludes request_user_input — auto-managed). */
function getToolOptions(
  namespace: string,
  allowedTools: Record<string, string[] | boolean>,
  builtinTools?: BuiltinToolsConfig,
  probedTools?: Record<string, string[]>,
): string[] {
  if (namespace === "builtin") {
    if (!builtinTools) return [];
    // Return enabled builtin tool names, excluding request_user_input (auto-managed)
    return Object.entries(builtinTools)
      .filter(([name, cfg]) => name !== "request_user_input" && cfg && typeof cfg === "object" && "enabled" in cfg && cfg.enabled)
      .map(([name]) => name);
  }
  // MCP server: use specific allowed tools if configured, otherwise use probed tools
  const configured = allowedTools[namespace];
  if (!configured) return [];
  if (configured === true) return probedTools?.[namespace] || [];
  if (configured.length > 0) return configured;
  // Empty array means "all tools" (legacy) — use probed tools if available
  return probedTools?.[namespace] || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function InterruptConfigPicker({
  value,
  onChange,
  allowedTools,
  builtinTools,
  disabled = false,
}: InterruptConfigPickerProps) {
  const [rows, setRows] = React.useState<InterruptRow[]>(() => configToRows(value));
  const [expandedRows, setExpandedRows] = React.useState<Set<string>>(new Set());
  const [probedTools, setProbedTools] = React.useState<Record<string, string[]>>({});
  const [probingServers, setProbingServers] = React.useState<Set<string>>(new Set());

  // Probe a single MCP server for its tools
  const probeServer = React.useCallback((serverId: string) => {
    if (probedTools[serverId] || probingServers.has(serverId)) return;
    setProbingServers((prev) => new Set(prev).add(serverId));
    fetch(`/api/mcp-servers/probe?id=${serverId}`, { method: "POST" })
      .then((res) => res.json())
      .then((data) => {
        if (data.data?.tools) {
          setProbedTools((prev) => ({
            ...prev,
            [serverId]: (data.data.tools as { name: string }[]).map((t) => t.name),
          }));
        }
      })
      .catch(() => {})
      .finally(() => {
        setProbingServers((prev) => {
          const next = new Set(prev);
          next.delete(serverId);
          return next;
        });
      });
  }, [probedTools, probingServers]);

  // On mount, probe any MCP servers that existing rows reference (deduplicated)
  React.useEffect(() => {
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.namespace !== "builtin" && !seen.has(row.namespace)) {
        seen.add(row.namespace);
        probeServer(row.namespace);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally run once on mount

  // Sync rows → parent on change
  const updateRows = React.useCallback(
    (newRows: InterruptRow[]) => {
      setRows(newRows);
      onChange(rowsToConfig(newRows));
    },
    [onChange],
  );

  // Available namespaces: "builtin" + MCP server IDs
  const namespaces = React.useMemo(() => {
    const ns = ["builtin"];
    for (const serverId of Object.keys(allowedTools)) {
      ns.push(serverId);
    }
    return ns;
  }, [allowedTools]);

  // A row is "locked" if it's the builtin request_user_input rule and that tool is enabled.
  // Locked rows cannot be edited or deleted — they're auto-managed.
  const isLockedRow = React.useCallback(
    (row: InterruptRow): boolean => {
      if (row.namespace !== "builtin" || row.tool !== "request_user_input") return false;
      if (!builtinTools) return false;
      const cfg = builtinTools["request_user_input" as keyof BuiltinToolsConfig];
      return !!(cfg && typeof cfg === "object" && "enabled" in cfg && cfg.enabled);
    },
    [builtinTools],
  );

  // Check if a row's tool still exists in the current config
  const isStaleRow = React.useCallback(
    (row: InterruptRow): boolean => {
      if (row.tool === "*") return false;
      // Locked rows are never stale (auto-managed)
      if (row.namespace === "builtin" && row.tool === "request_user_input") return false;
      const available = getToolOptions(row.namespace, allowedTools, builtinTools, probedTools);
      // If namespace doesn't exist at all, it's stale
      if (row.namespace !== "builtin" && !allowedTools[row.namespace]) return true;
      // If tools is true or empty array (meaning "all"), we can't validate — assume ok
      const val = allowedTools[row.namespace];
      if (row.namespace !== "builtin" && (val === true || (Array.isArray(val) && val.length === 0))) return false;
      return !available.includes(row.tool);
    },
    [allowedTools, builtinTools, probedTools],
  );

  const addRow = () => {
    const newRow: InterruptRow = {
      id: nextRowId(),
      namespace: "builtin",
      tool: "*",
      mode: "default",
      allowed_decisions: [...ALL_DECISIONS],
    };
    updateRows([...rows, newRow]);
  };

  const removeRow = (id: string) => {
    updateRows(rows.filter((r) => r.id !== id));
    setExpandedRows((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const updateRow = (id: string, patch: Partial<InterruptRow>) => {
    updateRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const toggleExpanded = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleNamespaceChange = (rowId: string, namespace: string) => {
    // Probe MCP server if not already probed
    if (namespace !== "builtin") {
      probeServer(namespace);
    }
    // Reset tool to "all tools" when namespace changes
    updateRow(rowId, { namespace, tool: "*" });
  };

  const handleToolChange = (rowId: string, tool: string) => {
    updateRow(rowId, { tool });
  };

  const handleDecisionToggle = (rowId: string, decision: DecisionType) => {
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;

    const current = row.allowed_decisions;
    // Don't allow unchecking the last decision
    if (current.includes(decision) && current.length <= 1) return;

    const next = current.includes(decision)
      ? current.filter((d) => d !== decision)
      : [...current, decision];

    updateRow(rowId, { allowed_decisions: next, mode: "custom" });
  };

  return (
    <div className="space-y-3">
      {/* Top-right add button */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Tools listed here will pause execution and require human approval before running.
        </p>
        <Button
          type="button"
          size="sm"
          className="h-7 text-xs gap-1.5 shrink-0 ml-4"
          onClick={addRow}
          disabled={disabled}
        >
          <Plus className="h-3 w-3" />
          Add rule
        </Button>
      </div>

      {rows.length === 0 && (
        <p className="text-xs text-muted-foreground italic py-2">
          No interrupt rules configured. The agent will execute all tools without approval.
        </p>
      )}

      <div className="space-y-2">
        {rows.map((row) => {
          const isExpanded = expandedRows.has(row.id);
          const stale = isStaleRow(row);
          const locked = isLockedRow(row);
          const toolOptions = getToolOptions(row.namespace, allowedTools, builtinTools, probedTools);
          // Filter out tools that already have a rule (one rule per namespace+tool)
          const usedTools = new Set(
            rows.filter((r) => r.id !== row.id && r.namespace === row.namespace).map((r) => r.tool),
          );
          const availableToolOptions = toolOptions.filter((t) => !usedTools.has(t));
          // Also disable "All tools" if another row in same namespace already uses it
          const allToolsTaken = usedTools.has("*");
          const pickerToolOptions = [
            {
              value: "*",
              label: "All tools",
              disabled: allToolsTaken && row.tool !== "*",
            },
            ...(row.tool !== "*" && !availableToolOptions.includes(row.tool)
              ? [{ value: row.tool, label: row.tool, disabled: false }]
              : []),
            ...availableToolOptions.map((tool) => ({
              value: tool,
              label: tool,
              disabled: false,
            })),
          ];

          return (
            <div
              key={row.id}
              className={cn(
                "border rounded-md p-3 space-y-2",
                stale && "border-amber-400/50 bg-amber-50/50 dark:bg-amber-950/20",
                locked && "bg-muted/60",
              )}
            >
              {/* Main row */}
              <div className="flex items-center gap-2">
                {/* Namespace dropdown */}
                <div className="min-w-[100px]">
                  <SearchablePicker
                    options={namespaces}
                    selected={row.namespace}
                    onSelect={(namespace) =>
                      handleNamespaceChange(row.id, namespace)
                    }
                    getOptionKey={(namespace) => namespace}
                    getOptionLabel={(namespace) =>
                      namespace === "builtin" ? "Built-in" : namespace
                    }
                    placeholder="Namespace"
                    searchPlaceholder="Search namespaces..."
                    emptyLabel="No namespaces available"
                    ariaLabel="Interrupt namespace"
                    required
                    disabled={disabled || locked}
                    triggerClassName={cn(
                      "h-8 px-2 text-xs font-mono",
                      locked && "text-muted-foreground",
                    )}
                  />
                </div>

                {/* Tool dropdown */}
                {row.namespace !== "builtin" && row.tool !== "*" && probingServers.has(row.namespace) ? (
                  <span className="h-8 rounded-md border bg-background px-2 text-xs font-mono min-w-[140px] flex-1 flex items-center text-muted-foreground">
                    Loading tools…
                  </span>
                ) : (
                  <div className="min-w-[140px] flex-1">
                    <SearchablePicker
                      options={pickerToolOptions}
                      selected={pickerToolOptions.find(
                        (option) => option.value === row.tool,
                      )}
                      onSelect={(option) =>
                        handleToolChange(row.id, option.value)
                      }
                      getOptionKey={(option) => option.value}
                      getOptionLabel={(option) => option.label}
                      isOptionDisabled={(option) => option.disabled}
                      placeholder="Select a tool"
                      searchPlaceholder="Search tools..."
                      emptyLabel="No tools available"
                      ariaLabel="Interrupt tool"
                      required
                      disabled={disabled || locked}
                      triggerClassName={cn(
                        "h-8 px-2 text-xs font-mono",
                        locked && "text-muted-foreground",
                      )}
                    />
                  </div>
                )}

                {/* Stale warning */}
                {stale && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">
                          This tool is no longer in the agent&apos;s tool set.
                          It will be ignored at runtime.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}

                {/* Locked row info */}
                {locked && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-4 w-4 text-muted-foreground shrink-0" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">
                          Required while the request_user_input tool is enabled.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}

                {/* Configure button */}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleExpanded(row.id)}
                  disabled={locked}
                  className={cn("h-8 w-8 p-0", isExpanded && "text-primary")}
                  title="Configure allowed decisions"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                </Button>

                {/* Remove button */}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeRow(row.id)}
                  disabled={disabled || locked}
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                  title={locked ? "This rule is required while the tool is enabled" : "Remove rule"}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              {/* Expanded: decision checkboxes */}
              {isExpanded && (
                <div className="pl-2 pt-1 flex items-center gap-4">
                  <span className="text-xs text-muted-foreground">Allowed decisions:</span>
                  {ALL_DECISIONS.map((decision) => {
                    const checked = row.allowed_decisions.includes(decision);
                    const isLast = row.allowed_decisions.length <= 1 && checked;
                    return (
                      <label
                        key={decision}
                        className={cn(
                          "flex items-center gap-1.5 text-xs cursor-pointer",
                          isLast && "opacity-50 cursor-not-allowed",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled || isLast}
                          onChange={() => handleDecisionToggle(row.id, decision)}
                          className="h-3.5 w-3.5 rounded border-gray-300"
                        />
                        <span className="capitalize">{decision}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
