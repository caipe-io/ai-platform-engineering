"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WorkspacePageActions } from "@/components/layout/WorkspacePageActions";
import { Card,CardContent } from "@/components/ui/card";
import {
Dialog,
DialogContent,
DialogDescription,
DialogFooter,
DialogHeader,
DialogTitle,
} from "@/components/ui/dialog";
import { AgentPicker, type AgentPickerOption } from "@/components/ui/agent-picker";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { toYaml } from "@/lib/yaml-serializer";
import type { MCPServerConfigWithPermissions, MCPToolInfo } from "@/types/dynamic-agent";
import {
AlertCircle,
CheckCircle2,
Download,
FlaskConical,
Globe,
Loader2,
Plus,
Radio,
RefreshCw,
Server,
Terminal,
ToggleLeft,
ToggleRight,
Trash2,
Zap,
} from "lucide-react";
import React from "react";
import { MCPServerEditor, type MCPServerInitialValues } from "./MCPServerEditor";
import { RemoteMCPCatalogDialog, type RemoteMCPTemplate } from "./RemoteMCPCatalogDialog";

// assisted-by Codex Codex-sonnet-4-6
export const MCP_SERVERS_REFRESH_INTERVAL_MS = 10_000;
const MCP_SERVERS_LIST_URL = "/api/mcp-servers?page_size=100";

const DEFAULT_ROW_PERMISSIONS = {
  can_manage: false,
  can_invoke: false,
  can_discover: false,
} as const;

interface ProbeResult {
  server_id: string;
  loading: boolean;
  tools?: MCPToolInfo[];
  error?: string;
}

type ToolHealthStatus = "healthy" | "degraded" | "checking" | "unknown" | "disabled";

interface FetchServersOptions {
  showLoading?: boolean;
  preserveListOnError?: boolean;
}

interface MCPServersTabProps {
  selectedServerId?: string | null;
  onSelectedServerChange?: (serverId: string | null) => void;
}

interface ToolTestResult {
  success: boolean;
  application_success?: boolean;
  status?: number;
  result?: unknown;
  error?: string;
  credential_resolution?: Array<{
    name: string;
    kind: string;
    origin: string;
    provider?: string;
    provider_connection_id?: string;
  }>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isLockedConfigDrivenServer(server: MCPServerConfigWithPermissions | null | undefined): boolean {
  return server?.config_driven === true && server.source !== "agentgateway";
}

function serverCanManage(server: MCPServerConfigWithPermissions | null | undefined): boolean {
  return server?.permissions?.can_manage === true;
}

function serverCanInvoke(server: MCPServerConfigWithPermissions | null | undefined): boolean {
  return server?.permissions?.can_invoke === true;
}

function serverCanProbe(server: MCPServerConfigWithPermissions | null | undefined): boolean {
  return server?.permissions?.can_discover === true;
}

function serverCanTest(server: MCPServerConfigWithPermissions | null | undefined): boolean {
  return serverCanInvoke(server) || serverCanManage(server);
}

function toolHealthStatus(
  server: MCPServerConfigWithPermissions,
  probe: ProbeResult | undefined,
): { status: ToolHealthStatus; label: string; title: string } {
  if (!server.enabled) {
    return {
      status: "disabled",
      label: "Disabled",
      title: "Disabled servers are not scanned for tools",
    };
  }
  if (probe?.loading) {
    return {
      status: "checking",
      label: "Checking",
      title: "Listing MCP tools",
    };
  }
  if (probe?.error || (probe?.tools && probe.tools.length === 0)) {
    return {
      status: "degraded",
      label: "Degraded",
      title: probe.error || "tools/list returned no tools",
    };
  }
  if (probe?.tools && probe.tools.length > 0) {
    return {
      status: "healthy",
      label: "Healthy",
      title: `${probe.tools.length} tool${probe.tools.length === 1 ? "" : "s"} available`,
    };
  }
  if (!serverCanProbe(server)) {
    return {
      status: "unknown",
      label: "Not scanned",
      title: "You do not have permission to scan this MCP server",
    };
  }
  if (server.transport !== "http") {
    return {
      status: "unknown",
      label: "Not scanned",
      title: "Tool health scans currently support HTTP MCP servers",
    };
  }
  return {
    status: "unknown",
    label: "Not scanned",
    title: "Run the tool probe to check tools/list health",
  };
}

function toolHealthClass(status: ToolHealthStatus): string {
  switch (status) {
    case "healthy":
      return "text-green-600 dark:text-green-400";
    case "degraded":
      return "text-amber-600 dark:text-amber-400";
    case "checking":
    case "unknown":
    case "disabled":
      return "text-muted-foreground";
  }
}

function toolHealthDotClass(status: ToolHealthStatus): string {
  switch (status) {
    case "healthy":
      return "bg-green-500";
    case "degraded":
      return "bg-amber-500";
    case "checking":
      return "bg-blue-500";
    case "unknown":
    case "disabled":
      return "bg-muted-foreground/60";
  }
}

export function MCPServersTab({
  selectedServerId,
  onSelectedServerChange,
}: MCPServersTabProps = {}) {
  const [servers, setServers] = React.useState<MCPServerConfigWithPermissions[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [editingServer, setEditingServer] = React.useState<MCPServerConfigWithPermissions | null>(null);
  const [selectionLoading, setSelectionLoading] = React.useState(false);
  const [selectionError, setSelectionError] = React.useState<string | null>(null);
  const selectionRequestRef = React.useRef(0);
  const loadedSelectionIdRef = React.useRef<string | null>(null);
  const [isCreating, setIsCreating] = React.useState(false);
  const [showCatalog, setShowCatalog] = React.useState(false);
  const [catalogInitialValues, setCatalogInitialValues] = React.useState<MCPServerInitialValues | null>(null);
  const [probeResults, setProbeResults] = React.useState<Record<string, ProbeResult>>({});
  const [testingServer, setTestingServer] = React.useState<MCPServerConfigWithPermissions | null>(null);
  const [pendingDeleteServerId, setPendingDeleteServerId] = React.useState<string | null>(null);
  const [deletingServerId, setDeletingServerId] = React.useState<string | null>(null);
  const [rowActionErrors, setRowActionErrors] = React.useState<Record<string, string>>({});

  const fetchServers = React.useCallback(async ({
    showLoading = true,
    preserveListOnError = false,
  }: FetchServersOptions = {}) => {
    if (showLoading) {
      setLoading(true);
    }
    if (!preserveListOnError) {
      setError(null);
    }
    try {
      const response = await fetch(MCP_SERVERS_LIST_URL, { cache: "no-store" });
      const data = await response.json();
      if (data.success) {
        const items = (data.data.items || []) as MCPServerConfigWithPermissions[];
        setServers(
          items.map((server) => ({
            ...server,
            permissions: server.permissions ?? DEFAULT_ROW_PERMISSIONS,
          })),
        );
        setError(null);
      } else {
        if (!preserveListOnError) {
          setError(data.error || "Failed to fetch servers");
        }
      }
    } catch (err: unknown) {
      if (!preserveListOnError) {
        setError(errorMessage(err, "Failed to fetch servers"));
      }
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, []);

  React.useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  React.useEffect(() => {
    if (selectedServerId === undefined) return;

    const requestId = ++selectionRequestRef.current;
    if (!selectedServerId) {
      loadedSelectionIdRef.current = null;
      setEditingServer(null);
      setSelectionError(null);
      setSelectionLoading(false);
      return;
    }

    if (loadedSelectionIdRef.current === selectedServerId) {
      setSelectionError(null);
      setSelectionLoading(false);
      return;
    }

    setSelectionLoading(true);
    setSelectionError(null);
    void (async () => {
      try {
        const response = await fetch(`/api/mcp-servers?id=${encodeURIComponent(selectedServerId)}`, {
          cache: "no-store",
        });
        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || "MCP server not found");
        }
        if (selectionRequestRef.current === requestId) {
          loadedSelectionIdRef.current = selectedServerId;
          setEditingServer({
            ...data.data,
            permissions: data.data.permissions ?? DEFAULT_ROW_PERMISSIONS,
          });
        }
      } catch (err: unknown) {
        if (selectionRequestRef.current === requestId) {
          loadedSelectionIdRef.current = null;
          setEditingServer(null);
          setSelectionError(errorMessage(err, "Failed to load MCP server"));
        }
      } finally {
        if (selectionRequestRef.current === requestId) {
          setSelectionLoading(false);
        }
      }
    })();
  }, [selectedServerId]);

  React.useEffect(() => {
    const refreshFromBackend = () => {
      void fetchServers({ showLoading: false, preserveListOnError: true });
    };

    const intervalId = window.setInterval(refreshFromBackend, MCP_SERVERS_REFRESH_INTERVAL_MS);

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        refreshFromBackend();
      }
    };

    window.addEventListener("focus", refreshFromBackend);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshFromBackend);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [fetchServers]);

  const clearRowActionError = React.useCallback((serverId: string) => {
    setRowActionErrors((prev) => {
      if (!prev[serverId]) return prev;
      const next = { ...prev };
      delete next[serverId];
      return next;
    });
  }, []);

  const handleDelete = async (serverId: string) => {
    setDeletingServerId(serverId);
    clearRowActionError(serverId);
    try {
      const response = await fetch(`/api/mcp-servers?id=${serverId}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (data.success) {
        setPendingDeleteServerId(null);
        fetchServers();
      } else {
        setRowActionErrors((prev) => ({
          ...prev,
          [serverId]: data.error || "Failed to delete server",
        }));
      }
    } catch (err: unknown) {
      setRowActionErrors((prev) => ({
        ...prev,
        [serverId]: errorMessage(err, "Failed to delete server"),
      }));
    } finally {
      setDeletingServerId(null);
    }
  };

  const handleToggleEnabled = async (server: MCPServerConfigWithPermissions) => {
    if (!serverCanManage(server)) return;
    clearRowActionError(server._id);
    try {
      const response = await fetch(`/api/mcp-servers?id=${server._id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !server.enabled }),
      });
      const data = await response.json();
      if (data.success) {
        fetchServers();
      } else {
        setRowActionErrors((prev) => ({
          ...prev,
          [server._id]: data.error || "Failed to update server",
        }));
      }
    } catch (err: unknown) {
      setRowActionErrors((prev) => ({
        ...prev,
        [server._id]: errorMessage(err, "Failed to update server"),
      }));
    }
  };

  const handleProbe = async (serverId: string) => {
    setProbeResults((prev) => ({
      ...prev,
      [serverId]: { server_id: serverId, loading: true },
    }));

    try {
      const response = await fetch(`/api/mcp-servers/probe?id=${serverId}`, {
        method: "POST",
      });
      const data = await response.json();
      
      // Check outer success (API call succeeded)
      if (data.success) {
        // Check inner success (probe operation succeeded)
        const probeData = data.data;
        if (probeData.success === false) {
          // Probe failed (e.g., connection error to MCP server)
          setProbeResults((prev) => ({
            ...prev,
            [serverId]: {
              server_id: serverId,
              loading: false,
              error: probeData.error || "Probe failed",
            },
          }));
        } else {
          // Probe succeeded
          setProbeResults((prev) => ({
            ...prev,
            [serverId]: {
              server_id: serverId,
              loading: false,
              tools: probeData.tools,
            },
          }));
        }
      } else {
        // API call itself failed
        setProbeResults((prev) => ({
          ...prev,
          [serverId]: {
            server_id: serverId,
            loading: false,
            error: data.error || "Probe failed",
          },
        }));
      }
    } catch (err: unknown) {
      setProbeResults((prev) => ({
        ...prev,
        [serverId]: {
          server_id: serverId,
          loading: false,
          error: errorMessage(err, "Probe failed"),
        },
      }));
    }
  };

  /**
   * Export server configuration as YAML file
   */
  const handleExportYaml = (server: MCPServerConfigWithPermissions) => {
    const exportConfig = {
      id: server._id,
      name: server.name,
      description: server.description || undefined,
      transport: server.transport,
      endpoint: server.transport !== "stdio" ? server.endpoint : undefined,
      command: server.transport === "stdio" ? server.command : undefined,
      args: server.transport === "stdio" && server.args?.length ? server.args : undefined,
      env: server.transport === "stdio" && server.env && Object.keys(server.env).length ? server.env : undefined,
      enabled: server.enabled,
    };

    const yamlContent = toYaml(exportConfig);
    const blob = new Blob([yamlContent], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${server._id}.yaml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const getTransportIcon = (transport: string) => {
    switch (transport) {
      case "stdio":
        return <Terminal className="h-3 w-3" />;
      case "sse":
        return <Radio className="h-3 w-3" />;
      case "http":
        return <Globe className="h-3 w-3" />;
      default:
        return <Server className="h-3 w-3" />;
    }
  };

  const getTransportColor = (transport: string) => {
    switch (transport) {
      case "stdio":
        return "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30";
      case "sse":
        return "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30";
      case "http":
        return "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30";
      default:
        return "bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30";
    }
  };

  const openServer = (server: MCPServerConfigWithPermissions) => {
    loadedSelectionIdRef.current = server._id;
    setSelectionError(null);
    setEditingServer(server);
    onSelectedServerChange?.(server._id);
  };

  const closeServerEditor = () => {
    selectionRequestRef.current += 1;
    loadedSelectionIdRef.current = null;
    setEditingServer(null);
    setIsCreating(false);
    setCatalogInitialValues(null);
    setSelectionError(null);
    setSelectionLoading(false);
    onSelectedServerChange?.(null);
  };

  const handleCatalogSelect = (template: RemoteMCPTemplate) => {
    setCatalogInitialValues({
      name: template.name,
      description: template.description,
      endpoint: template.endpoint,
      credential_sources: template.credential_sources,
    });
    setIsCreating(true);
  };

  const hasMatchingSelectedServer = editingServer?._id === selectedServerId;

  if (selectedServerId && selectionLoading && !hasMatchingSelectedServer) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (selectedServerId && selectionError && !hasMatchingSelectedServer) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-destructive">{selectionError}</p>
          <Button variant="outline" className="mt-4" onClick={closeServerEditor}>
            Back to MCP Servers
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (isCreating || editingServer) {
    return (
      <MCPServerEditor
        key={editingServer?._id ?? "new"}
        server={editingServer}
        initialValues={catalogInitialValues ?? undefined}
        readOnly={
          isCreating
            ? false
            : isLockedConfigDrivenServer(editingServer) || !serverCanManage(editingServer)
        }
        onSave={() => {
          closeServerEditor();
          fetchServers();
        }}
        onCancel={closeServerEditor}
      />
    );
  }

  return (
    <>
      <RemoteMCPCatalogDialog
        open={showCatalog}
        onOpenChange={setShowCatalog}
        onSelect={handleCatalogSelect}
        onSelectCustom={() => setIsCreating(true)}
      />
      <WorkspacePageActions>
        <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => fetchServers()} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setShowCatalog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Server
            </Button>
        </div>
      </WorkspacePageActions>
      <Card className="rounded-none border-0 bg-transparent shadow-none">
        <CardContent className="px-0 pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="text-center py-12">
            <p className="text-destructive">{error}</p>
            <Button variant="outline" className="mt-4" onClick={() => fetchServers()}>
              Retry
            </Button>
          </div>
        ) : servers.length === 0 ? (
          <div className="text-center py-12">
            <Server className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">No MCP Servers Yet</h3>
            <p className="text-muted-foreground mb-4">
              Add your first MCP server to enable tool access for agents.
            </p>
            <Button onClick={() => setShowCatalog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Server
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Header */}
            <div className="grid grid-cols-12 gap-4 pb-2 border-b text-xs font-medium text-muted-foreground px-2">
              <div className="col-span-3">Name</div>
              <div className="col-span-2">Transport</div>
              <div className="col-span-3">Endpoint / Command</div>
              <div className="col-span-2">Status</div>
              <div className="col-span-2 text-right">Actions</div>
            </div>

            {/* Server rows */}
            {servers.map((server) => {
              const probe = probeResults[server._id];
              const rowActionError = rowActionErrors[server._id];
              const toolHealth = toolHealthStatus(server, probe);
              return (
                <div
                  aria-label={`MCP server ${server.name}`}
                  className="space-y-2"
                  key={server._id}
                  role="group"
                >
                  <div
                    className={`grid grid-cols-12 gap-4 py-3 px-2 rounded-lg hover:bg-muted/50 items-center ${
                      serverCanManage(server) ? "cursor-pointer" : "cursor-default"
                    }`}
                    onClick={() => openServer(server)}
                  >
                    <div className="col-span-3">
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded-lg bg-blue-500/10 flex items-center justify-center">
                          <Server className="h-5 w-5 text-blue-500" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <div className="font-medium text-sm">{server.name}</div>
                            {server.source === "agentgateway" && (
                              <Badge
                                variant="outline"
                                className="gap-1 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/30"
                                title="Registered from AgentGateway discovery"
                              >
                                AgentGateway
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground font-mono">
                            {server._id}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="col-span-2">
                      <Badge
                        variant="outline"
                        className={`gap-1 ${getTransportColor(server.transport)}`}
                      >
                        {getTransportIcon(server.transport)}
                        {server.transport}
                      </Badge>
                    </div>

                    <div className="col-span-3">
                      <span className="text-sm text-muted-foreground truncate block max-w-[200px]">
                        {server.transport === "stdio"
                          ? server.command
                          : server.endpoint}
                      </span>
                      {server.source === "agentgateway" && server.agentgateway_target_endpoint && (
                        <span className="text-xs text-muted-foreground truncate block max-w-[200px]">
                          Target: {server.agentgateway_target_endpoint}
                        </span>
                      )}
                    </div>

                    <div className="col-span-2 space-y-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isLockedConfigDrivenServer(server) || !serverCanManage(server)) return;
                          handleToggleEnabled(server);
                        }}
                        className={`flex items-center gap-1.5 ${
                          isLockedConfigDrivenServer(server) || !serverCanManage(server)
                            ? "cursor-not-allowed opacity-60"
                            : ""
                        }`}
                        disabled={isLockedConfigDrivenServer(server) || !serverCanManage(server)}
                        title={
                          isLockedConfigDrivenServer(server)
                            ? "Config-driven servers cannot be modified"
                            : !serverCanManage(server)
                              ? "You do not have permission to modify this server"
                              : undefined
                        }
                      >
                        {server.enabled ? (
                          <>
                            <ToggleRight className="h-5 w-5 text-green-500" />
                            <span className="text-xs text-green-600 dark:text-green-400">
                              Active
                            </span>
                          </>
                        ) : (
                          <>
                            <ToggleLeft className="h-5 w-5 text-muted-foreground" />
                            <span className="text-xs text-muted-foreground">Disabled</span>
                          </>
                        )}
                      </button>
                      <div
                        className={`flex items-center gap-1.5 text-xs ${toolHealthClass(toolHealth.status)}`}
                        title={toolHealth.title}
                      >
                        {toolHealth.status === "checking" ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <span className={`h-2 w-2 rounded-full ${toolHealthDotClass(toolHealth.status)}`} />
                        )}
                        <span>{toolHealth.label}</span>
                      </div>
                    </div>

                    <div className="col-span-2 flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                      {serverCanProbe(server) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => handleProbe(server._id)}
                          disabled={probe?.loading}
                          aria-label={`Probe tools for ${server.name}`}
                          title="Probe for tools"
                        >
                          {probe?.loading ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Zap className="h-4 w-4" />
                          )}
                        </Button>
                      )}
                      {serverCanTest(server) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => setTestingServer(server)}
                          disabled={server.transport !== "http" || !server.enabled}
                          aria-label={`Test MCP tools for ${server.name}`}
                          title={
                            server.transport === "http"
                              ? "Test MCP tools"
                              : "Tool testing currently supports HTTP MCP servers"
                          }
                        >
                          <FlaskConical className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleExportYaml(server)}
                        aria-label={`Export ${server.name} as YAML`}
                        title="Export as YAML"
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                      {isLockedConfigDrivenServer(server) && (
                        <Badge
                          variant="outline"
                          className="gap-1 bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30"
                          title="Loaded from config.yaml - cannot be edited"
                        >
                          Config
                        </Badge>
                      )}
                      {!isLockedConfigDrivenServer(server) && serverCanManage(server) && (
                        pendingDeleteServerId === server._id ? (
                          <div className="flex items-center gap-1 rounded-full border border-destructive/20 bg-destructive/10 px-2 py-1">
                            <span className="max-w-[7rem] truncate text-xs font-medium text-destructive">
                              Delete {server.name}?
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                              disabled={deletingServerId === server._id}
                              onClick={() => setPendingDeleteServerId(null)}
                            >
                              Cancel
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              aria-label={`Confirm delete ${server.name}`}
                              className="h-7 bg-destructive px-2 text-xs text-destructive-foreground hover:bg-destructive/90"
                              disabled={deletingServerId === server._id}
                              onClick={() => void handleDelete(server._id)}
                            >
                              {deletingServerId === server._id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                "Delete"
                              )}
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => {
                              setPendingDeleteServerId(server._id);
                              clearRowActionError(server._id);
                            }}
                            aria-label={`Delete ${server.name}`}
                            title="Delete server"
                            disabled={deletingServerId === server._id}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )
                      )}
                    </div>
                  </div>

                  {rowActionError && (
                    <div className="ml-12 pl-4 border-l-2 border-destructive/30">
                      <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/30 p-3">
                        <AlertCircle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
                        <div className="flex flex-1 items-start justify-between gap-3">
                          <p className="text-sm text-destructive">{rowActionError}</p>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => clearRowActionError(server._id)}
                          >
                            Dismiss
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Probe results */}
                  {probe && !probe.loading && (
                    <div className="ml-12 pl-4 border-l-2 border-muted">
                      {probe.error ? (
                        <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 p-3">
                          <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                          <div className="space-y-1">
                            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Tool Scan Degraded</p>
                            <p className="text-sm text-amber-700 dark:text-amber-400">{probe.error}</p>
                          </div>
                        </div>
                      ) : probe.tools && probe.tools.length > 0 ? (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <CheckCircle2 className="h-4 w-4 text-green-500" />
                            <p className="text-sm text-green-600 dark:text-green-400 font-medium">
                              {probe.tools.length} tool(s) available
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {probe.tools.map((tool) => (
                              <Badge
                                key={tool.namespaced_name}
                                variant="secondary"
                                className="text-xs font-mono"
                                title={tool.description || tool.name}
                              >
                                {tool.name}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 text-amber-700 dark:text-amber-400">
                          <AlertCircle className="h-4 w-4" />
                          <p className="text-sm">Tool scan returned no tools</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        </CardContent>
      <MCPToolTestDialog
        server={testingServer}
        open={Boolean(testingServer)}
        onOpenChange={(open) => {
          if (!open) setTestingServer(null);
        }}
      />
      </Card>
    </>
  );
}

function preferredTool(tools: MCPToolInfo[]): string {
  const safe = tools.find((tool) => /(version|health|ping|status|about|info)/i.test(tool.name));
  return safe?.name ?? tools[0]?.name ?? "";
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

interface ToolSchemaProperty {
  name: string;
  type: string;
  description: string;
  required: boolean;
  enumValues?: string[];
  defaultValue?: unknown;
}

function toolInputSchema(tool: MCPToolInfo | undefined): Record<string, unknown> | null {
  const schema = tool?.inputSchema ?? tool?.input_schema;
  return schema && typeof schema === "object" && !Array.isArray(schema)
    ? (schema as Record<string, unknown>)
    : null;
}

function schemaProperties(tool: MCPToolInfo | undefined): ToolSchemaProperty[] {
  const schema = toolInputSchema(tool);
  const rawProperties = schema?.properties;
  if (!rawProperties || typeof rawProperties !== "object" || Array.isArray(rawProperties)) {
    return [];
  }

  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((item) => typeof item === "string") : []);
  return Object.entries(rawProperties as Record<string, unknown>).map(([name, raw]) => {
    const property = raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
    const typeValue = Array.isArray(property.type) ? property.type[0] : property.type;
    const enumValues = Array.isArray(property.enum)
      ? property.enum.filter((item): item is string => typeof item === "string")
      : undefined;
    return {
      name,
      type: typeof typeValue === "string" ? typeValue : enumValues?.length ? "string" : "string",
      description: typeof property.description === "string" ? property.description : "",
      required: required.has(name),
      enumValues,
      defaultValue: property.default,
    };
  });
}

interface ParamRow {
  id: string;
  key: string;
  value: string;
}

let paramRowIdCounter = 0;

function createParamRow(overrides?: Partial<Pick<ParamRow, "key" | "value">>): ParamRow {
  paramRowIdCounter += 1;
  return {
    id: `param-row-${paramRowIdCounter}`,
    key: overrides?.key ?? "",
    value: overrides?.value ?? "",
  };
}

function rowsFromSchema(properties: ToolSchemaProperty[]): ParamRow[] {
  if (properties.length === 0) {
    return [createParamRow()];
  }
  return properties.map((property) => {
    let value = "";
    if (typeof property.defaultValue === "boolean") {
      value = String(property.defaultValue);
    } else if (
      typeof property.defaultValue === "number" ||
      typeof property.defaultValue === "string"
    ) {
      value = String(property.defaultValue);
    } else if (property.type === "boolean") {
      value = "false";
    }
    return createParamRow({ key: property.name, value });
  });
}

function coerceParamValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  if (raw.startsWith("{") || raw.startsWith("[") || raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

function buildParamsFromRows(
  rows: ParamRow[],
  properties: ToolSchemaProperty[],
): Record<string, unknown> {
  const required = new Set(properties.filter((property) => property.required).map((property) => property.name));
  const params: Record<string, unknown> = {};
  const seenKeys = new Set<string>();

  for (const row of rows) {
    const key = row.key.trim();
    const value = row.value.trim();
    if (!key && !value) continue;
    if (!key) {
      throw new Error("Each parameter row needs a name");
    }
    if (seenKeys.has(key)) {
      throw new Error(`Duplicate parameter: ${key}`);
    }
    seenKeys.add(key);
    if (!value) {
      if (required.has(key)) {
        throw new Error(`${key} is required`);
      }
      continue;
    }
    params[key] = coerceParamValue(value);
  }

  for (const key of required) {
    if (!(key in params)) {
      throw new Error(`${key} is required`);
    }
  }

  return params;
}

function rowsFromParamsObject(params: Record<string, unknown>): ParamRow[] {
  const entries = Object.entries(params);
  if (entries.length === 0) {
    return [createParamRow()];
  }
  return entries.map(([key, value]) =>
    createParamRow({
      key,
      value: typeof value === "string" ? value : prettyJson(value),
    }),
  );
}


function MCPToolTestDialog({
  server,
  open,
  onOpenChange,
}: {
  server: MCPServerConfigWithPermissions | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [loadingTools, setLoadingTools] = React.useState(false);
  const [tools, setTools] = React.useState<MCPToolInfo[]>([]);
  const [selectedTool, setSelectedTool] = React.useState("");
  const [paramsText, setParamsText] = React.useState("{}");
  const [paramsMode, setParamsMode] = React.useState<"fields" | "json">("fields");
  const [paramRows, setParamRows] = React.useState<ParamRow[]>(() => [createParamRow()]);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ToolTestResult | null>(null);

  React.useEffect(() => {
    if (!open || !server) return;
    let cancelled = false;
    setLoadingTools(true);
    setTools([]);
    setSelectedTool("");
    setParamsText("{}");
    setParamsMode("fields");
    setParamRows([createParamRow()]);
    setResult(null);
    setError(null);

    async function loadTools() {
      try {
        const response = await fetch(`/api/mcp-servers/probe?id=${server?._id}`, {
          method: "POST",
        });
        const data = await response.json();
        if (!data.success || data.data?.success === false) {
          throw new Error(data.data?.error || data.error || "Could not load tools");
        }
        const nextTools = Array.isArray(data.data?.tools) ? data.data.tools : [];
        if (cancelled) return;
        setTools(nextTools);
        setSelectedTool(preferredTool(nextTools));
      } catch (err: unknown) {
        if (!cancelled) setError(errorMessage(err, "Could not load tools"));
      } finally {
        if (!cancelled) setLoadingTools(false);
      }
    }

    void loadTools();
    return () => {
      cancelled = true;
    };
  }, [open, server]);

  const selectedToolDetails = tools.find((tool) => tool.name === selectedTool);
  const toolPickerOptions: AgentPickerOption[] = React.useMemo(
    () =>
      tools.map((tool) => ({
        value: tool.name,
        label: tool.name,
      })),
    [tools],
  );
  const selectedProperties = React.useMemo(
    () => schemaProperties(selectedToolDetails),
    [selectedToolDetails],
  );
  const hasRequiredParams = selectedProperties.some((property) => property.required);
  const schemaMissing = selectedProperties.length === 0;

  React.useEffect(() => {
    setResult(null);
    setError(null);
    setParamRows(rowsFromSchema(selectedProperties));
    setParamsText("{}");
    setParamsMode("fields");
  }, [selectedTool, selectedProperties]);

  function updateParamRow(id: string, patch: Partial<Pick<ParamRow, "key" | "value">>) {
    setParamRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
    setResult(null);
  }

  function addParamRow() {
    setParamRows((current) => [...current, createParamRow()]);
    setResult(null);
  }

  function removeParamRow(id: string) {
    setParamRows((current) => {
      if (current.length <= 1) {
        return [createParamRow()];
      }
      return current.filter((row) => row.id !== id);
    });
    setResult(null);
  }

  async function runTool() {
    if (!server || !selectedTool) return;
    setError(null);
    setResult(null);

    let params: Record<string, unknown>;
    if (paramsMode === "fields") {
      try {
        params = buildParamsFromRows(paramRows, selectedProperties);
      } catch (err: unknown) {
        setError(errorMessage(err, "Check the parameter rows"));
        return;
      }
    } else {
      try {
        const parsed = JSON.parse(paramsText || "{}") as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Params must be a JSON object");
        }
        params = parsed as Record<string, unknown>;
      } catch (err: unknown) {
        setError(errorMessage(err, "Params must be valid JSON"));
        return;
      }
    }

    setRunning(true);
    try {
      const response = await fetch("/api/mcp-servers/test-tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: server._id,
          toolName: selectedTool,
          params,
        }),
      });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || "Tool test failed");
      }
      setResult(data.data as ToolTestResult);
    } catch (err: unknown) {
      setError(errorMessage(err, "Tool test failed"));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl h-[85vh] max-h-[85vh] gap-4 overflow-hidden p-6"
        style={{ display: "flex", flexDirection: "column" }}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>Test MCP tools</DialogTitle>
          <DialogDescription>
            {server
              ? `Run a saved tool from ${server.name}. Requests use the same AgentGateway route and authorization checks as agents.`
              : "Run a saved MCP tool."}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1" data-testid="mcp-tool-test-scroll">
          <div className="flex flex-col gap-4 pr-3">
          {loadingTools ? (
            <div className="flex items-center gap-2 rounded-md border p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading tools...
            </div>
          ) : tools.length > 0 ? (
            <>
              <div className="grid gap-2">
                <label htmlFor="mcp-test-tool" className="text-sm font-medium">
                  Tool
                </label>
                <AgentPicker
                  id="mcp-test-tool"
                  ariaLabel="Tool"
                  options={toolPickerOptions}
                  value={selectedTool}
                  onChange={(value) => {
                    setSelectedTool(value);
                    setResult(null);
                  }}
                  placeholder="Select tool..."
                  searchPlaceholder="Search tools..."
                  emptyLabel="No tools match"
                  hideIdSuffix
                />
                {selectedToolDetails?.description && (
                  <p className="text-xs text-muted-foreground">{selectedToolDetails.description}</p>
                )}
              </div>

              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <label htmlFor={paramsMode === "json" ? "mcp-test-params" : undefined} className="text-sm font-medium">
                      Parameters
                    </label>
                    <p className="text-xs text-muted-foreground">
                      {schemaMissing
                        ? "Add name/value rows with +, or switch to JSON for nested objects."
                        : hasRequiredParams
                          ? "Required parameters must have a value. Add more rows with + if needed."
                          : "Optional rows can be left blank or removed."}
                    </p>
                  </div>
                  <div className="flex rounded-md bg-muted p-1" aria-label="Parameter entry mode">
                    <Button
                      type="button"
                      size="sm"
                      variant={paramsMode === "fields" ? "secondary" : "ghost"}
                      className="h-7 px-2 text-xs"
                      onClick={() => {
                        if (paramsMode === "json") {
                          try {
                            const parsed = JSON.parse(paramsText || "{}") as unknown;
                            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                              setParamRows(rowsFromParamsObject(parsed as Record<string, unknown>));
                            } else {
                              setParamRows([createParamRow()]);
                            }
                          } catch {
                            setParamRows([createParamRow()]);
                          }
                        }
                        setParamsMode("fields");
                      }}
                    >
                      Fields
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={paramsMode === "json" ? "secondary" : "ghost"}
                      className="h-7 px-2 text-xs"
                      onClick={() => {
                        if (paramsMode === "fields") {
                          try {
                            setParamsText(prettyJson(buildParamsFromRows(paramRows, selectedProperties)));
                          } catch {
                            setParamsText("{}");
                          }
                        }
                        setParamsMode("json");
                      }}
                    >
                      JSON
                    </Button>
                  </div>
                </div>

                {paramsMode === "fields" ? (
                  <div className="grid gap-3 rounded-md border p-3">
                    {paramRows.map((row, index) => {
                      const schemaProperty = selectedProperties.find((property) => property.name === row.key.trim());
                      const valueLabel = row.key.trim()
                        ? `Value for ${row.key.trim()}`
                        : `Parameter value ${index + 1}`;
                      return (
                        <div key={row.id} className="grid gap-1.5">
                          <div className="flex items-start gap-2">
                            <div className="grid flex-1 gap-1.5 sm:grid-cols-2">
                              <div className="grid gap-1">
                                <label htmlFor={`mcp-test-param-key-${row.id}`} className="text-xs text-muted-foreground">
                                  Name
                                </label>
                                <input
                                  id={`mcp-test-param-key-${row.id}`}
                                  value={row.key}
                                  onChange={(event) => updateParamRow(row.id, { key: event.target.value })}
                                  placeholder="parameter_name"
                                  className="h-10 rounded-md border border-input bg-background px-3 text-sm font-mono"
                                />
                              </div>
                              <div className="grid gap-1">
                                <div className="flex items-center justify-between gap-2">
                                  <label htmlFor={`mcp-test-param-value-${row.id}`} className="text-xs text-muted-foreground">
                                    Value
                                  </label>
                                  {schemaProperty?.required ? (
                                    <Badge variant="outline" className="text-[10px] uppercase">
                                      Required
                                    </Badge>
                                  ) : null}
                                </div>
                                <input
                                  id={`mcp-test-param-value-${row.id}`}
                                  aria-label={valueLabel}
                                  value={row.value}
                                  onChange={(event) => updateParamRow(row.id, { value: event.target.value })}
                                  placeholder={schemaProperty?.required ? "Required value" : "Optional value"}
                                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                                />
                              </div>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="mt-6 h-10 w-10 shrink-0 text-muted-foreground hover:text-destructive"
                              aria-label={`Remove parameter row ${index + 1}`}
                              onClick={() => removeParamRow(row.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          {schemaProperty?.description ? (
                            <p className="text-xs text-muted-foreground">{schemaProperty.description}</p>
                          ) : null}
                        </div>
                      );
                    })}
                    <Button type="button" variant="outline" size="sm" className="w-fit" onClick={addParamRow}>
                      <Plus className="mr-2 h-4 w-4" />
                      Add parameter
                    </Button>
                  </div>
                ) : (
                  <>
                    <Textarea
                      id="mcp-test-params"
                      value={paramsText}
                      onChange={(event) => setParamsText(event.target.value)}
                      className="min-h-28 font-mono text-xs"
                      spellCheck={false}
                      placeholder={
                        schemaMissing
                          ? '{"jql": "project = MERAKI ORDER BY updated DESC"}'
                          : "{}"
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      {schemaMissing
                        ? "Pass a JSON object with the tool argument names and values."
                        : <>Use <code className="font-mono">{"{}"}</code> for tools that do not take arguments.</>}
                    </p>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="rounded-md border p-4 text-sm text-muted-foreground">
              No tools were found for this MCP server.
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {result && (
            <div className="grid gap-2">
              {(() => {
                const transportOk = result.success;
                const applicationOk = result.application_success ?? result.success;
                const showApplicationWarning = transportOk && !applicationOk;
                return (
                  <>
                    <div className="flex items-center gap-2 text-sm">
                      {showApplicationWarning ? (
                        <AlertCircle className="h-4 w-4 text-amber-500" />
                      ) : transportOk ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-destructive" />
                      )}
                      <span
                        className={
                          showApplicationWarning
                            ? "text-amber-600 dark:text-amber-400"
                            : transportOk
                              ? "text-green-600 dark:text-green-400"
                              : "text-destructive"
                        }
                      >
                        {showApplicationWarning
                          ? "MCP call succeeded, but the tool returned an application error"
                          : transportOk
                            ? "Tool call succeeded"
                            : "Tool call failed"}
                      </span>
                    </div>
                    {result.credential_resolution && result.credential_resolution.length > 0 && (
                      <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                        <p className="font-medium text-foreground">Credential resolution</p>
                        <ul className="mt-1 space-y-1">
                          {result.credential_resolution.map((entry) => (
                            <li key={`${entry.kind}-${entry.name}`}>
                              {entry.name}: {entry.origin}
                              {entry.provider ? ` (${entry.provider})` : ""}
                              {entry.origin === "none"
                                ? " — connect the provider under Credentials or check MCP server credential sources"
                                : ""}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                );
              })()}
              <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
                {prettyJson(result.result ?? result.error ?? result)}
              </pre>
            </div>
          )}
          </div>
        </ScrollArea>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={() => void runTool()} disabled={running || loadingTools || !selectedTool || tools.length === 0}>
            {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FlaskConical className="mr-2 h-4 w-4" />}
            Run tool
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
