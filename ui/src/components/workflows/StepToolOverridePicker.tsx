"use client";

// assisted-by Codex Codex-sonnet-4-6

import { cn } from "@/lib/utils";
import type { BuiltinToolDefinition,BuiltinToolsConfig,DynamicAgentConfig } from "@/types/dynamic-agent";
import {
AlertTriangle,
ChevronDown,
ChevronRight,
Loader2,
Lock,
Server,
Wrench,
} from "lucide-react";
import { useCallback,useEffect,useMemo,useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StepToolOverridePickerProps {
  agentId: string | undefined;
  configOverride: Record<string, unknown> | null;
  onConfigOverrideChange: (override: Record<string, unknown> | null) => void;
  readOnly?: boolean;
}

interface ProbeResult {
  loading: boolean;
  tools?: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get enabled builtin tool IDs from an agent config's builtin_tools */
function getEnabledBuiltinTools(builtinTools?: BuiltinToolsConfig | null): string[] {
  if (!builtinTools) return [];
  const enabled: string[] = [];
  for (const [key, value] of Object.entries(builtinTools)) {
    if (key === "workflows") continue; // not a tool
    if (value && typeof value === "object" && "enabled" in value && value.enabled) {
      // Normalize deprecated "sleep" → "wait"
      enabled.push(key === "sleep" ? "wait" : key);
    }
  }
  return enabled;
}

/** Extract disabled builtin tool IDs from a builtin_tools override object */
function getDisabledFromBuiltinOverride(
  builtinOverride: Record<string, { enabled?: boolean }> | undefined,
): string[] {
  if (!builtinOverride) return [];
  return Object.entries(builtinOverride)
    .filter(([, v]) => v && typeof v === "object" && v.enabled === false)
    .map(([k]) => k);
}

/** Count summary for the header */
function buildSummary(
  overrideAllowed: Record<string, string[] | boolean> | undefined,
  disabledBuiltinCount: number,
): string | null {
  if (!overrideAllowed && disabledBuiltinCount === 0) return null;

  let serverCount = 0;
  let toolCount = 0;

  if (overrideAllowed) {
    for (const [, val] of Object.entries(overrideAllowed)) {
      if (val === false) continue;
      serverCount++;
      if (val === true) {
        toolCount += 1;
      } else if (Array.isArray(val)) {
        toolCount += val.length || 1;
      }
    }
  }

  const parts: string[] = [];
  if (serverCount > 0) parts.push(`${serverCount} server${serverCount !== 1 ? "s" : ""}`);
  if (toolCount > 0) parts.push(`${toolCount} tool${toolCount !== 1 ? "s" : ""}`);
  if (disabledBuiltinCount > 0) parts.push(`${disabledBuiltinCount} builtin disabled`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Normalize a per-server allowed_tools value.
 * Legacy format used `[]` (empty array) to mean "all tools on this server".
 * The new canonical format uses `true` for the same meaning.
 * This converts legacy `[]` → `true` so it never persists in state or config.
 */
function normalizeToolsValue(val: string[] | boolean): string[] | boolean {
  return Array.isArray(val) && val.length === 0 ? true : val;
}

/** Normalize an entire allowed_tools record */
function normalizeAllowedTools(
  tools: Record<string, string[] | boolean>,
): Record<string, string[] | boolean> {
  const out: Record<string, string[] | boolean> = {};
  for (const [k, v] of Object.entries(tools)) {
    out[k] = normalizeToolsValue(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StepToolOverridePicker({
  agentId,
  configOverride,
  onConfigOverrideChange,
  readOnly,
}: StepToolOverridePickerProps) {
  // ── Section collapse state ──
  const [isExpanded, setIsExpanded] = useState(false);

  // ── Agent config (fetched when agentId changes) ──
  const [agentConfig, setAgentConfig] = useState<DynamicAgentConfig | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);

  // ── Builtin tool definitions from backend (source of truth) ──
  const [builtinDefs, setBuiltinDefs] = useState<BuiltinToolDefinition[]>([]);
  useEffect(() => {
    fetch("/api/dynamic-agents/builtin-tools")
      .then((r) => r.ok ? r.json() : null)
      .then((json) => {
        // Endpoint returns { data: { tools: [...] } }; accept a bare array too.
        const tools = Array.isArray(json?.data)
          ? json.data
          : (json?.data?.tools ?? []);
        setBuiltinDefs(tools);
      })
      .catch(() => {});
  }, []);

  // Map of valid builtin tool IDs → display names (from backend)
  const builtinLabelMap = useMemo(
    () => new Map(builtinDefs.map((d) => [d.id, d.name])),
    [builtinDefs],
  );

  // ── Server probe state (lazy) ──
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult>>({});

  // ── Derived: base allowed tools & builtin tools from agent ──
  const baseAllowedTools = useMemo(
    () => normalizeAllowedTools(agentConfig?.allowed_tools ?? {}),
    [agentConfig],
  );
  // Only show builtin tools that exist in BOTH the backend definitions AND the agent config
  const baseBuiltinTools = useMemo(
    () => getEnabledBuiltinTools(agentConfig?.builtin_tools).filter((id) => builtinLabelMap.has(id)),
    [agentConfig, builtinLabelMap],
  );

  // ── Derived: current override values ──
  const overrideAllowedTools = useMemo(
    () => {
      const raw = configOverride?.allowed_tools as Record<string, string[] | boolean> | undefined;
      return raw ? normalizeAllowedTools(raw) : undefined;
    },
    [configOverride],
  );
  const staleOverrideServers = useMemo(
    () => Object.keys(overrideAllowedTools ?? {})
      .filter((serverId) => !Object.prototype.hasOwnProperty.call(baseAllowedTools, serverId))
      .sort(),
    [baseAllowedTools, overrideAllowedTools],
  );
  const overrideBuiltinTools = useMemo(
    () => configOverride?.builtin_tools as Record<string, { enabled?: boolean }> | undefined,
    [configOverride],
  );
  const overrideBuiltinDisabled = useMemo(
    () => getDisabledFromBuiltinOverride(overrideBuiltinTools),
    [overrideBuiltinTools],
  );

  const mode: "inherit" | "restrict" = overrideAllowedTools || overrideBuiltinDisabled.length > 0 ? "restrict" : "inherit";

  // ── Fetch agent config ──
  useEffect(() => {
    if (!agentId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: reset agent config when agentId is cleared
      setAgentConfig(null);
      return;
    }
    let cancelled = false;

    setAgentLoading(true);
    fetch(`/api/dynamic-agents/agents/${encodeURIComponent(agentId)}`)
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled && json.success) {
          setAgentConfig(json.data);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setAgentLoading(false); });
    return () => { cancelled = true; };
  }, [agentId]);

  // ── Probe a server's tools (lazy, on expand) ──
  const probeServer = useCallback((serverId: string) => {
    if (probeResults[serverId]?.tools || probeResults[serverId]?.loading) return;
    setProbeResults((prev) => ({ ...prev, [serverId]: { loading: true } }));
    fetch(`/api/mcp-servers/probe?id=${serverId}`, { method: "POST" })
      .then((r) => r.json())
      .then((json) => {
        if (json.success && json.data?.tools) {
          setProbeResults((prev) => ({
            ...prev,
            [serverId]: { loading: false, tools: json.data.tools.map((t: { name: string }) => t.name) },
          }));
        } else {
          setProbeResults((prev) => ({
            ...prev,
            [serverId]: { loading: false, error: json.error || "Probe failed" },
          }));
        }
      })
      .catch((err) => {
        setProbeResults((prev) => ({
          ...prev,
          [serverId]: { loading: false, error: err.message },
        }));
      });
  }, [probeResults]);

  const toggleServerExpand = useCallback((serverId: string) => {
    setExpandedServers((prev) => {
      const next = new Set(prev);
      if (next.has(serverId)) {
        next.delete(serverId);
      } else {
        next.add(serverId);
        // Probe if needed (server has true/[] meaning "all tools" — need to know what they are)
        const baseVal = baseAllowedTools[serverId];
        if (baseVal === true || (Array.isArray(baseVal) && baseVal.length === 0)) {
          probeServer(serverId);
        }
      }
      return next;
    });
  }, [baseAllowedTools, probeServer]);

  // ── Update helpers ──
  const updateOverride = useCallback(
    (allowedTools: Record<string, string[] | boolean> | undefined, disabledBuiltin: string[] | undefined) => {
      const next = { ...(configOverride || {}) };
      // Remove legacy field if present
      delete next.disabled_builtin_tools;
      if (allowedTools && Object.keys(allowedTools).length > 0) {
        next.allowed_tools = allowedTools;
      } else {
        delete next.allowed_tools;
      }
      if (disabledBuiltin && disabledBuiltin.length > 0) {
        const builtinObj: Record<string, { enabled: boolean }> = {};
        for (const toolId of disabledBuiltin) {
          builtinObj[toolId] = { enabled: false };
        }
        next.builtin_tools = builtinObj;
      } else {
        delete next.builtin_tools;
      }
      onConfigOverrideChange(Object.keys(next).length > 0 ? next : null);
    },
    [configOverride, onConfigOverrideChange],
  );

  const setMode = useCallback(
    (newMode: "inherit" | "restrict") => {
      if (newMode === "inherit") {
        updateOverride(undefined, undefined);
      } else {
        const initial: Record<string, string[] | boolean> = {};
        for (const [sid, val] of Object.entries(baseAllowedTools)) {
          if (val === false) continue;
          initial[sid] = val;
        }
        updateOverride(
          Object.keys(initial).length > 0 ? initial : undefined,
          undefined,
        );
      }
    },
    [baseAllowedTools, updateOverride],
  );

  const toggleServer = useCallback(
    (serverId: string) => {
      if (readOnly) return;
      const current = { ...(overrideAllowedTools || {}) };
      if (current[serverId] === false) {
        current[serverId] = baseAllowedTools[serverId] ?? true;
      } else {
        current[serverId] = false;
      }
      updateOverride(current, overrideBuiltinDisabled.length > 0 ? overrideBuiltinDisabled : undefined);
    },
    [readOnly, overrideAllowedTools, baseAllowedTools, overrideBuiltinDisabled, updateOverride],
  );

  const toggleServerTool = useCallback(
    (serverId: string, toolName: string) => {
      if (readOnly) return;
      const current = { ...(overrideAllowedTools || {}) };
      const currentVal = current[serverId];

      const baseVal = baseAllowedTools[serverId];
      const allTools: string[] = Array.isArray(baseVal)
        ? baseVal
        : (probeResults[serverId]?.tools || []);

      if (currentVal === true || (Array.isArray(currentVal) && currentVal.length === 0)) {
        current[serverId] = allTools.filter((t) => t !== toolName);
      } else if (Array.isArray(currentVal)) {
        if (currentVal.includes(toolName)) {
          const filtered = currentVal.filter((t) => t !== toolName);
          if (filtered.length === 0) {
            current[serverId] = false;
          } else {
            current[serverId] = filtered;
          }
        } else {
          const updated = [...currentVal, toolName];
          if (allTools.length > 0 && updated.length === allTools.length) {
            current[serverId] = true;
          } else {
            current[serverId] = updated;
          }
        }
      }

      updateOverride(current, overrideBuiltinDisabled.length > 0 ? overrideBuiltinDisabled : undefined);
    },
    [readOnly, overrideAllowedTools, baseAllowedTools, probeResults, overrideBuiltinDisabled, updateOverride],
  );

  const toggleBuiltinTool = useCallback(
    (toolId: string) => {
      if (readOnly) return;
      const current = [...overrideBuiltinDisabled];
      const idx = current.indexOf(toolId);
      if (idx >= 0) {
        current.splice(idx, 1);
      } else {
        current.push(toolId);
      }
      updateOverride(overrideAllowedTools, current.length > 0 ? current : undefined);
    },
    [readOnly, overrideBuiltinDisabled, overrideAllowedTools, updateOverride],
  );

  // ── Summary for header ──
  const summary = buildSummary(overrideAllowedTools, overrideBuiltinDisabled.length);

  // ── Don't render if no agent selected ──
  if (!agentId) return null;

  // ── Active servers from base (exclude false) ──
  const activeBaseServers = Object.entries(baseAllowedTools).filter(([, v]) => v !== false);

  return (
    <div>
      {/* Collapsible header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors group"
      >
        <Lock className="h-3 w-3" />
        <span className="font-medium">Restrict Tool Access</span>
        {summary && (
          <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full">
            {summary}
          </span>
        )}
        {isExpanded ? (
          <ChevronDown className="h-3 w-3 ml-auto opacity-50 group-hover:opacity-100" />
        ) : (
          <ChevronRight className="h-3 w-3 ml-auto opacity-50 group-hover:opacity-100" />
        )}
      </button>

      {isExpanded && (
        <div className="mt-3 space-y-3">
          {agentLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-4 justify-center">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading agent config...
            </div>
          ) : !agentConfig ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              Select an agent to configure tool access.
            </p>
          ) : (
            <>
              {staleOverrideServers.length > 0 && (
                <div
                  role="alert"
                  className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    This saved override references unavailable server{staleOverrideServers.length !== 1 ? "s" : ""}: {staleOverrideServers.join(", ")}. Refresh the agent configuration and recreate the step override before running.
                  </span>
                </div>
              )}
              <fieldset disabled={!!readOnly} className="space-y-3">
              {/* Mode toggle */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setMode("inherit")}
                  className={cn(
                    "flex-1 px-3 py-2 rounded-md border text-xs font-medium transition-all",
                    mode === "inherit"
                      ? "border-primary bg-primary/10 text-primary shadow-sm"
                      : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
                  )}
                >
                  All tools in this agent
                </button>
                <button
                  type="button"
                  onClick={() => setMode("restrict")}
                  className={cn(
                    "flex-1 px-3 py-2 rounded-md border text-xs font-medium transition-all",
                    mode === "restrict"
                      ? "border-primary bg-primary/10 text-primary shadow-sm"
                      : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
                  )}
                >
                  Restrict for this step
                </button>
              </div>

              {mode === "restrict" && (
                <div className="space-y-3">
                  {/* Tool connections */}
                  {activeBaseServers.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5">
                        <Server className="h-3 w-3 text-muted-foreground" />
                        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                          Tool Connections
                        </span>
                      </div>
                      <div className="space-y-1.5">
                        {activeBaseServers.map(([serverId, baseVal]) => {
                          const overrideVal = overrideAllowedTools?.[serverId];
                          const isEnabled = overrideVal !== false;
                          const isServerExpanded = expandedServers.has(serverId);
                          const probe = probeResults[serverId];

                          const knownTools: string[] = Array.isArray(baseVal) && baseVal.length > 0
                            ? baseVal
                            : (probe?.tools || []);
                          const needsProbe = (baseVal === true || (Array.isArray(baseVal) && baseVal.length === 0)) && !probe?.tools;

                          const selectedTools: Set<string> | "all" = (() => {
                            if (!isEnabled) return new Set<string>();
                            if (overrideVal === true || (Array.isArray(overrideVal) && overrideVal.length === 0)) return "all";
                            if (Array.isArray(overrideVal)) return new Set(overrideVal);
                            if (baseVal === true || (Array.isArray(baseVal) && baseVal.length === 0)) return "all";
                            if (Array.isArray(baseVal)) return new Set(baseVal);
                            return "all";
                          })();

                          return (
                            <div
                              key={serverId}
                              className={cn(
                                "rounded-lg border transition-colors",
                                isEnabled
                                  ? "border-border bg-card"
                                  : "border-border/50 bg-muted/30 opacity-60",
                              )}
                            >
                              <div className="flex items-center gap-2 px-3 py-2">
                                <input
                                  type="checkbox"
                                  checked={isEnabled}
                                  onChange={() => toggleServer(serverId)}
                                  className="h-3.5 w-3.5 rounded border-border"
                                />
                                <button
                                  type="button"
                                  onClick={() => toggleServerExpand(serverId)}
                                  className="flex items-center gap-1.5 flex-1 text-left text-xs font-medium text-foreground hover:text-primary transition-colors min-w-0"
                                >
                                  {isServerExpanded ? (
                                    <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                                  ) : (
                                    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                                  )}
                                  <span className="truncate">{serverId}</span>
                                </button>
                                <span className={cn(
                                  "text-[10px] shrink-0 px-1.5 py-0.5 rounded-full",
                                  !isEnabled
                                    ? "bg-muted text-muted-foreground"
                                    : selectedTools === "all"
                                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                    : "bg-blue-500/10 text-blue-600 dark:text-blue-400",
                                )}>
                                  {!isEnabled
                                    ? "disabled"
                                    : selectedTools === "all"
                                    ? "all tools"
                                    : `${selectedTools.size} tool${selectedTools.size !== 1 ? "s" : ""}`}
                                </span>
                              </div>

                              {isServerExpanded && isEnabled && (
                                <div className="px-3 pb-2.5 pt-0.5 ml-6 border-t border-border/50">
                                  {probe?.loading ? (
                                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground py-2">
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                      Discovering tools...
                                    </div>
                                  ) : probe?.error ? (
                                    <p className="text-[11px] text-destructive py-2">{probe.error}</p>
                                  ) : needsProbe ? (
                                    <p className="text-[11px] text-muted-foreground py-2">Loading...</p>
                                  ) : knownTools.length === 0 ? (
                                    <p className="text-[11px] text-muted-foreground py-2">No tools discovered</p>
                                  ) : (
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1.5">
                                      {knownTools.map((tool) => (
                                        <label
                                          key={tool}
                                          className="flex items-center gap-1.5 text-[11px] cursor-pointer hover:text-foreground transition-colors py-0.5"
                                        >
                                          <input
                                            type="checkbox"
                                            checked={selectedTools === "all" || selectedTools.has(tool)}
                                            onChange={() => toggleServerTool(serverId, tool)}
                                            className="h-3 w-3 rounded border-border"
                                          />
                                          <span className="font-mono truncate">{tool}</span>
                                        </label>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Builtin Tools */}
                  {baseBuiltinTools.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5">
                        <Wrench className="h-3 w-3 text-muted-foreground" />
                        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                          Builtin Tools
                        </span>
                      </div>
                      <div className="rounded-lg border border-border bg-card px-3 py-2 space-y-1">
                        {baseBuiltinTools.map((toolId) => {
                          const isDisabled = overrideBuiltinDisabled.includes(toolId);
                          return (
                            <div key={toolId} className="flex items-center gap-2 py-0.5">
                              <input
                                type="checkbox"
                                checked={!isDisabled}
                                onChange={() => toggleBuiltinTool(toolId)}
                                className="h-3.5 w-3.5 rounded border-border"
                              />
                              <span className={cn(
                                "text-xs transition-colors",
                                isDisabled ? "text-muted-foreground line-through" : "text-foreground",
                              )}>
                                {builtinLabelMap.get(toolId) || toolId}
                              </span>
                              {toolId === "request_user_input" && isDisabled && (
                                <span className="flex items-center gap-1 text-[10px] text-amber-500 ml-auto">
                                  <AlertTriangle className="h-3 w-3" />
                                  Cannot ask questions
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {activeBaseServers.length === 0 && baseBuiltinTools.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-3">
                      This agent has no tools configured.
                    </p>
                  )}
                </div>
              )}
              </fieldset>
            </>
          )}
        </div>
      )}
    </div>
  );
}
