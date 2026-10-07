"use client";

// assisted-by Codex Codex-sonnet-4-6

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card,CardContent,CardDescription,CardHeader,CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProviderSelect } from "@/components/ui/provider-select";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import { Select } from "@/components/ui/select";
import { TeamPicker,type TeamPickerOption } from "@/components/ui/team-picker";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  SUPPRESS_PASSWORD_MANAGER_FORM_PROPS,
  SUPPRESS_PASSWORD_MANAGER_INPUT_PROPS,
  SUPPRESS_SECRET_LIKE_INPUT_PROPS,
} from "@/lib/suppress-password-manager";
import { normalizeCustomProviderCredentialSource } from "@/lib/mcp-credential-scope";
import type {
MCPCredentialSource,
MCPServerConfig,
MCPServerConfigCreate,
MCPServerConfigUpdate,
TransportType,
} from "@/types/dynamic-agent";
import { ArrowLeft,Info,Loader2,Plus,X } from "lucide-react";
import React from "react";

export interface MCPServerInitialValues {
  name?: string;
  description?: string;
  endpoint?: string;
  credential_sources?: MCPCredentialSource[];
}

interface MCPServerEditorProps {
  server: MCPServerConfig | null; // null = creating new
  readOnly?: boolean;
  onSave: () => void;
  onCancel: () => void;
  initialValues?: MCPServerInitialValues;
}

const TRANSPORT_OPTIONS: { value: TransportType; label: string; description: string }[] = [
  { value: "stdio", label: "STDIO", description: "Local process via stdin/stdout" },
  {
    value: "http",
    label: "Streamable HTTP",
    description: "MCP Streamable HTTP endpoint (recommended)",
  },
];

const MCP_PROVIDER_CREDENTIAL_HEADER = "X-CAIPE-Provider-Token";
const HEADER_NAME_OPTIONS = [MCP_PROVIDER_CREDENTIAL_HEADER, "Authorization"] as const;
const CUSTOM_HEADER_VALUE = "__custom__";

function normalizeCredentialHeaderName(name: string): string {
  const trimmed = name.trim();
  if (/^(authorization|x-caipe-token)$/i.test(trimmed)) {
    return MCP_PROVIDER_CREDENTIAL_HEADER;
  }
  return trimmed;
}

function normalizeCredentialSourcesForEditor(
  sources: MCPCredentialSource[] | undefined,
): MCPCredentialSource[] {
  return (sources ?? []).map((source) =>
    source.target === "header"
      ? { ...source, name: normalizeCredentialHeaderName(source.name) }
      : source,
  );
}

function usesAgentGatewayRouting(transportType: TransportType): boolean {
  return transportType !== "stdio";
}

interface EndpointProbeAttempt {
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
}

interface EndpointProbeResult {
  attempts: EndpointProbeAttempt[];
  suggestedUrl?: string;
}

interface SecretReferenceOption {
  id: string;
  name: string;
  type?: string;
  maskedPreview?: string;
}

interface ProviderConnectionOption {
  id: string;
  connectorId?: string;
  provider: string;
  status?: string;
  updatedAt?: string;
  connectedAt?: string;
  expiresAt?: string;
  profileSummary?: string;
  owner?: {
    email?: string;
    name?: string;
    displayName?: string;
  };
}

interface OAuthConnectorOption {
  id: string;
  name: string;
  provider: string;
}

async function fetchCredentialOptions<T>(url: string): Promise<T[]> {
  const response = await fetch(url);
  if (!response.ok) return [];
  const json = (await response.json()) as { data?: unknown };
  return Array.isArray(json.data) ? (json.data as T[]) : [];
}

function deriveServerIdFromDisplayName(displayName: string): string {
  return displayName
    .trim()
    .toLowerCase()
    .replace(/^mcp[-_\s]+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function secretOptionLabel(secret: SecretReferenceOption): string {
  return secret.name;
}

function selectedSecretOption(
  source: MCPCredentialSource,
  secrets: SecretReferenceOption[],
): SecretReferenceOption | undefined {
  if (source.kind !== "secret_ref" || !source.secret_ref) return undefined;
  return secrets.find((secret) => secret.id === source.secret_ref);
}

function normalizedCredentialSource(
  source: MCPCredentialSource,
  providerConnections: ProviderConnectionOption[],
): MCPCredentialSource | null {
  const name = source.name.trim();
  if (!name) return null;

  if (source.kind === "secret_ref") {
    const secretRef = source.secret_ref?.trim();
    if (!secretRef) return null;
    return {
      kind: "secret_ref",
      target: source.target,
      name,
      secret_ref: secretRef,
    };
  }

  if (source.kind === "provider_connection") {
    return normalizeCustomProviderCredentialSource(source, providerConnections);
  }

  return {
    kind: "caller_token",
    target: source.target,
    name,
    ...(source.fallback_env ? { fallback_env: source.fallback_env } : {}),
    ...(source.fallback_client_credentials
      ? { fallback_client_credentials: source.fallback_client_credentials }
      : {}),
  };
}

export function MCPServerEditor({ server, readOnly, onSave, onCancel, initialValues }: MCPServerEditorProps) {
  const isEditing = !!server;

  // Form state
  const [id, setId] = React.useState(server?._id || "");
  const [idManuallyEdited, setIdManuallyEdited] = React.useState(Boolean(server?._id));
  const [showGeneratedNameEditor, setShowGeneratedNameEditor] = React.useState(false);
  const [name, setName] = React.useState(server?.name || initialValues?.name || "");
  const [description, setDescription] = React.useState(server?.description || initialValues?.description || "");
  const [transport, setTransport] = React.useState<TransportType>(server?.transport || "http");
  const [endpoint, setEndpoint] = React.useState(
    server?.agentgateway_target_endpoint || server?.endpoint || initialValues?.endpoint || "",
  );
  const [pickedAgentGatewayUpstream, setPickedAgentGatewayUpstream] = React.useState(
    server?.agentgateway_target_endpoint?.trim() || initialValues?.endpoint?.trim() || "",
  );
  const [command, setCommand] = React.useState(server?.command || "");
  const [args, setArgs] = React.useState<string[]>(server?.args || []);
  const [envVars, setEnvVars] = React.useState<{ key: string; value: string }[]>(
    server?.env ? Object.entries(server.env).map(([key, value]) => ({ key, value })) : []
  );
  const [credentialSources, setCredentialSources] = React.useState<MCPCredentialSource[]>(
    normalizeCredentialSourcesForEditor(server?.credential_sources ?? initialValues?.credential_sources),
  );

  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [secretOptions, setSecretOptions] = React.useState<SecretReferenceOption[]>([]);
  const [providerConnectionOptions, setProviderConnectionOptions] = React.useState<ProviderConnectionOption[]>([]);
  const [oauthConnectorOptions, setOauthConnectorOptions] = React.useState<OAuthConnectorOption[]>([]);
  const [endpointProbe, setEndpointProbe] = React.useState<EndpointProbeResult | null>(null);
  const [endpointProbeLoading, setEndpointProbeLoading] = React.useState(false);
  const [credentialProbe, setCredentialProbe] = React.useState<{
    ok: boolean;
    status?: number;
    error?: string;
    credentialOrigins: { name: string; origin: string; provider?: string }[];
    missingCredentials: string[];
  } | null>(null);
  const [credentialProbeLoading, setCredentialProbeLoading] = React.useState(false);

  // Arg input state
  const [newArg, setNewArg] = React.useState("");

  // AgentGateway target picker. Discovery is best-effort: when the
  // backend isn't reachable or AgentGateway isn't configured we just
  // hide the helper UI. Failing closed here would force the admin back
  // to typing endpoints by hand, which is what got us into the bare
  // `http://agentgateway:4000/mcp` (no `/<id>` suffix) → 404 mess.
  type AgentGatewayTarget = {
    id: string;
    name?: string;
    endpoint: string;
    target_endpoint?: string;
  };
  const [agentGatewayTargets, setAgentGatewayTargets] = React.useState<AgentGatewayTarget[]>([]);
  const [gatewayDiscoveryLoaded, setGatewayDiscoveryLoaded] = React.useState(false);
  const agentGatewayTargetOptions = React.useMemo<TeamPickerOption[]>(
    () =>
      agentGatewayTargets.map((target) => ({
        slug: target.id,
        name: target.name ?? target.id,
        description: target.target_endpoint ?? target.endpoint,
      })),
    [agentGatewayTargets],
  );
  const selectedAgentGatewayTargetId = React.useMemo(() => {
    const trimmedEndpoint = endpoint.trim();
    const trimmedUpstream = pickedAgentGatewayUpstream.trim();
    return (
      agentGatewayTargets.find(
        (target) =>
          target.endpoint === trimmedEndpoint ||
          target.target_endpoint?.trim() === trimmedEndpoint ||
          (trimmedUpstream.length > 0 && target.target_endpoint?.trim() === trimmedUpstream),
      )?.id ?? ""
    );
  }, [agentGatewayTargets, endpoint, pickedAgentGatewayUpstream]);

  React.useEffect(() => {
    let cancelled = false;
    async function loadDiscovery() {
      try {
        const res = await fetch("/api/mcp-servers/agentgateway/discover");
        if (!res.ok) {
          if (!cancelled) setGatewayDiscoveryLoaded(true);
          return;
        }
        const payload = (await res.json()) as {
          success?: boolean;
          data?: { targets?: AgentGatewayTarget[] };
        };
        if (!cancelled && payload?.success && Array.isArray(payload.data?.targets)) {
          setAgentGatewayTargets(payload.data.targets);
        }
      } catch {
        // best-effort; the dropdown just won't appear
      } finally {
        if (!cancelled) setGatewayDiscoveryLoaded(true);
      }
    }
    void loadDiscovery();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    async function loadCredentialOptions() {
      const [secrets, connections, connectors] = await Promise.all([
        fetchCredentialOptions<SecretReferenceOption>("/api/credentials/secrets").catch(() => []),
        fetchCredentialOptions<ProviderConnectionOption>("/api/credentials/connections").catch(() => []),
        fetchCredentialOptions<OAuthConnectorOption>("/api/credentials/oauth-connectors").catch(() => []),
      ]);
      if (cancelled) return;
      setSecretOptions(secrets);
      setProviderConnectionOptions(connections);
      setOauthConnectorOptions(connectors);
    }
    void loadCredentialOptions();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAddArg = () => {
    if (newArg.trim()) {
      setArgs([...args, newArg.trim()]);
      setNewArg("");
    }
  };

  const handleDisplayNameChange = (value: string) => {
    setName(value);
    if (!isEditing && !idManuallyEdited) {
      setId(deriveServerIdFromDisplayName(value));
    }
  };

  const handleRemoveArg = (index: number) => {
    setArgs(args.filter((_, i) => i !== index));
  };

  const handleAddEnvVar = () => {
    setEnvVars([...envVars, { key: "", value: "" }]);
  };

  const handleUpdateEnvVar = (index: number, field: "key" | "value", value: string) => {
    const updated = [...envVars];
    updated[index][field] = value;
    setEnvVars(updated);
  };

  const handleRemoveEnvVar = (index: number) => {
    setEnvVars(envVars.filter((_, i) => i !== index));
  };

  const handleAddCredentialSource = () => {
    setCredentialSources([
      ...credentialSources,
      {
        kind: "secret_ref",
        target: transport === "stdio" ? "env" : "header",
        name: transport === "stdio" ? "" : MCP_PROVIDER_CREDENTIAL_HEADER,
        secret_ref: "",
      },
    ]);
  };

  const handleSetCredentialSource = (index: number, source: MCPCredentialSource) => {
    const updated = [...credentialSources];
    updated[index] = source;
    setCredentialSources(updated);
  };

  const handleUpdateCredentialSource = (
    index: number,
    field: keyof MCPCredentialSource,
    value: string,
  ) => {
    if (field === "target") {
      const current = credentialSources[index];
      const nextTarget = value as MCPCredentialSource["target"];
      const currentNameIsDefaultHeader = HEADER_NAME_OPTIONS.includes(
        current.name as (typeof HEADER_NAME_OPTIONS)[number],
      );
      handleSetCredentialSource(index, {
        ...current,
        target: nextTarget,
        name: nextTarget === "env" && currentNameIsDefaultHeader
          ? ""
          : nextTarget === "header" && !current.name.trim()
          ? MCP_PROVIDER_CREDENTIAL_HEADER
          : current.name,
      });
      return;
    }
    handleSetCredentialSource(index, { ...credentialSources[index], [field]: value });
  };

  const handleSelectCredentialHeader = (index: number, value: string) => {
    if (value === CUSTOM_HEADER_VALUE) {
      const current = credentialSources[index];
      if (!HEADER_NAME_OPTIONS.includes(current.name as (typeof HEADER_NAME_OPTIONS)[number])) return;
      handleUpdateCredentialSource(index, "name", "");
      return;
    }
    handleUpdateCredentialSource(index, "name", value);
  };

  const handleUpdateCredentialKind = (index: number, kind: MCPCredentialSource["kind"]) => {
    const current = credentialSources[index];
    if (kind === "secret_ref") {
      handleSetCredentialSource(index, {
        kind,
        target: current.target,
        name: current.name,
        secret_ref: current.secret_ref || "",
      });
      return;
    }

    if (kind === "provider_connection") {
      const connection = providerConnectionOptions.find(
        (candidate) => candidate.id === current.provider_connection_id,
      );
      // Provider connections are always caller-scoped: the credential resolves
      // the caller's OWN connection for the chosen provider. (The shared
      // all-callers "pinned" scope was removed for security.)
      handleSetCredentialSource(index, {
        kind,
        target: current.target,
        name: current.name,
        connection_scope: "caller",
        provider:
          connection?.provider ??
          current.provider ??
          oauthConnectorOptions[0]?.provider ??
          "",
        provider_connection_id: undefined,
      });
      return;
    }

    handleSetCredentialSource(index, {
      kind,
      target: current.target,
      name: current.name,
    });
  };

  const handleRemoveCredentialSource = (index: number) => {
    setCredentialSources(credentialSources.filter((_, i) => i !== index));
  };

  const handleProbeEndpoint = async () => {
    setEndpointProbeLoading(true);
    setEndpointProbe(null);
    setError(null);
    try {
      const response = await fetch("/api/mcp-servers/endpoint-probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: endpoint, transport }),
      });
      const payload = (await response.json()) as { success?: boolean; data?: EndpointProbeResult; error?: string };
      if (!response.ok || payload.success === false || !payload.data) {
        throw new Error(payload.error || "Could not check endpoint");
      }
      setEndpointProbe(payload.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not check endpoint");
    } finally {
      setEndpointProbeLoading(false);
    }
  };

  const handleProbeCredentials = async () => {
    setCredentialProbeLoading(true);
    setCredentialProbe(null);
    setError(null);
    try {
      const normalizedSources = credentialSources
        .map((source) => normalizedCredentialSource(source, providerConnectionOptions))
        .filter((source): source is MCPCredentialSource => source !== null);
      const response = await fetch("/api/mcp-servers/credential-probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: endpoint, credential_sources: normalizedSources }),
      });
      const payload = (await response.json()) as {
        success?: boolean;
        data?: typeof credentialProbe;
        error?: string;
      };
      if (!response.ok || payload.success === false || !payload.data) {
        throw new Error(payload.error || "Could not test connection");
      }
      setCredentialProbe(payload.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not test connection");
    } finally {
      setCredentialProbeLoading(false);
    }
  };

  const handleOAuthConnect = (provider: string) => {
    const url = `/api/credentials/oauth/${encodeURIComponent(provider)}/connect`;
    const features = "popup=yes,width=640,height=760,resizable=yes,scrollbars=yes";
    const popup = window.open(url, `caipe-oauth-${provider}`, features);
    popup?.focus?.();
  };

  React.useEffect(() => {
    const handleOAuthMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== "caipe.oauth.connection") return;
      void handleProbeCredentials();
    };
    window.addEventListener("message", handleOAuthMessage);
    return () => window.removeEventListener("message", handleOAuthMessage);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, credentialSources, providerConnectionOptions]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // Build env object from array
      const env: Record<string, string> = {};
      envVars.forEach((ev) => {
        if (ev.key.trim()) {
          env[ev.key.trim()] = ev.value;
        }
      });

      if (isEditing) {
        const normalizedCredentialSources = credentialSources
          .map((source) => normalizedCredentialSource(source, providerConnectionOptions))
          .filter((source): source is MCPCredentialSource => source !== null);
        // Update existing server
        const updateData: MCPServerConfigUpdate = {
          name,
          description: description || undefined,
          transport,
          endpoint: transport !== "stdio" ? endpoint : undefined,
          ...(transport !== "stdio" && pickedAgentGatewayUpstream.trim()
            ? { agentgateway_target_endpoint: pickedAgentGatewayUpstream.trim() }
            : {}),
          command: transport === "stdio" ? command : undefined,
          args: transport === "stdio" ? args : undefined,
          env: transport === "stdio" && Object.keys(env).length > 0 ? env : undefined,
          // Always send credential_sources on update (including []) so the BFF can
          // clear previously saved bindings; omitting the field is a no-op.
          credential_sources: normalizedCredentialSources,
        };

        const response = await fetch(`/api/mcp-servers?id=${server._id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updateData),
        });

        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || "Failed to update server");
        }
      } else {
        const normalizedCredentialSources = credentialSources
          .map((source) => normalizedCredentialSource(source, providerConnectionOptions))
          .filter((source): source is MCPCredentialSource => source !== null);
        // Create new server
        const createData: MCPServerConfigCreate = {
          id: (id.trim() || deriveServerIdFromDisplayName(name)),
          name,
          description: description || undefined,
          transport,
          endpoint: transport !== "stdio" ? endpoint : undefined,
          ...(transport !== "stdio" && pickedAgentGatewayUpstream.trim()
            ? { agentgateway_target_endpoint: pickedAgentGatewayUpstream.trim() }
            : {}),
          command: transport === "stdio" ? command : undefined,
          args: transport === "stdio" ? args : undefined,
          env: transport === "stdio" && Object.keys(env).length > 0 ? env : undefined,
          credential_sources: normalizedCredentialSources.length > 0 ? normalizedCredentialSources : undefined,
        };

        const response = await fetch("/api/mcp-servers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createData),
        });

        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || "Failed to create server");
        }
      }

      onSave();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const isValid =
    name.trim() &&
    (isEditing || id.trim() || deriveServerIdFromDisplayName(name)) &&
    (transport === "stdio" ? command.trim() : endpoint.trim()) &&
    credentialSources.every((source) =>
      normalizedCredentialSource(source, providerConnectionOptions) !== null
    );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={onCancel}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <CardTitle>{readOnly ? "View MCP Server" : isEditing ? "Edit MCP Server" : "Add MCP Server"}</CardTitle>
            <CardDescription>
              {readOnly
                ? "This server is managed by configuration and cannot be edited."
                : isEditing
                ? "Update the server configuration"
                : "Configure a new MCP server connection"}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6" {...SUPPRESS_PASSWORD_MANAGER_FORM_PROPS}>
          <fieldset className={readOnly ? "opacity-70" : ""}>
          {/* Basic Info */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium">Basic Information</h3>

            <div className="space-y-2">
              <Label htmlFor="mcp-display-name">
                Display Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="mcp-display-name"
                name="mcp-display-name"
                placeholder="e.g., Meraki Docs"
                value={name}
                onChange={(e) => handleDisplayNameChange(e.target.value)}
                disabled={loading || readOnly}
                {...SUPPRESS_PASSWORD_MANAGER_INPUT_PROPS}
              />
              {!isEditing && (
                <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      Saved as{" "}
                      <code className="font-mono text-primary">
                        mcp-{id.trim() || deriveServerIdFromDisplayName(name) || "server-name"}
                      </code>
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => setShowGeneratedNameEditor((current) => !current)}
                      disabled={loading || readOnly}
                    >
                      {showGeneratedNameEditor ? "Hide" : "Edit generated name"}
                    </Button>
                  </div>
                  {showGeneratedNameEditor && (
                    <div className="mt-2 space-y-1.5">
                      <Label htmlFor="mcp-generated-name" className="text-xs">
                        Generated name
                      </Label>
                      <Input
                        id="mcp-generated-name"
                        name="mcp-generated-name"
                        aria-label="Generated name"
                        placeholder="meraki-docs"
                        value={id}
                        onChange={(e) => {
                          setIdManuallyEdited(true);
                          setId(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""));
                        }}
                        disabled={loading || readOnly}
                        className="h-9 font-mono text-xs"
                        {...SUPPRESS_PASSWORD_MANAGER_INPUT_PROPS}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                name="mcp-description"
                placeholder="What does this server provide?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={loading || readOnly}
                rows={2}
                {...SUPPRESS_PASSWORD_MANAGER_INPUT_PROPS}
              />
            </div>
          </div>

          {/* Transport */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium">Transport Configuration</h3>

            <div className="space-y-2">
              <Label>Transport Type</Label>
              <div className="flex gap-2">
                {TRANSPORT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setTransport(opt.value)}
                    className={`flex-1 p-3 rounded-lg border text-left transition-colors ${
                      transport === opt.value
                        ? "border-primary bg-primary/5"
                        : "border-muted hover:border-primary/50"
                    }`}
                    disabled={loading || readOnly}
                  >
                    <div className="font-medium text-sm">{opt.label}</div>
                    <div className="text-xs text-muted-foreground">{opt.description}</div>
                  </button>
                ))}
              </div>
              {isEditing && transport === "sse" ? (
                <p className="text-xs text-muted-foreground">
                  This server uses the legacy SSE transport. New servers should use Streamable HTTP.
                </p>
              ) : null}
            </div>

            {/* Transport-specific fields */}
            {transport === "stdio" ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="command">
                    Command <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="command"
                    name="mcp-command"
                    placeholder="e.g., npx, uvx, python"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    disabled={loading || readOnly}
                    className="font-mono"
                    {...SUPPRESS_PASSWORD_MANAGER_INPUT_PROPS}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Arguments</Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Add argument..."
                      value={newArg}
                      onChange={(e) => setNewArg(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddArg();
                        }
                      }}
                      disabled={loading || readOnly}
                      className="font-mono"
                      {...SUPPRESS_PASSWORD_MANAGER_INPUT_PROPS}
                    />
                    <Button type="button" variant="outline" onClick={handleAddArg} disabled={loading || readOnly}>
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  {args.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {args.map((arg, i) => (
                        <Badge key={i} variant="secondary" className="font-mono gap-1">
                          {arg}
                          <button
                            type="button"
                            onClick={() => handleRemoveArg(i)}
                            disabled={readOnly}
                            className="ml-1 hover:text-destructive"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Environment Variables</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleAddEnvVar}
                      disabled={loading || readOnly}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add
                    </Button>
                  </div>
                  {envVars.length > 0 && (
                    <div className="space-y-2">
                      {envVars.map((env, i) => (
                        <div key={i} className="flex gap-2">
                          <Input
                            placeholder="KEY"
                            value={env.key}
                            onChange={(e) => handleUpdateEnvVar(i, "key", e.target.value)}
                            disabled={loading || readOnly}
                            className="font-mono flex-1"
                            {...SUPPRESS_PASSWORD_MANAGER_INPUT_PROPS}
                          />
                          <Input
                            placeholder="value"
                            value={env.value}
                            onChange={(e) => handleUpdateEnvVar(i, "value", e.target.value)}
                            disabled={loading || readOnly}
                            className="font-mono flex-[2]"
                            {...SUPPRESS_SECRET_LIKE_INPUT_PROPS}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => handleRemoveEnvVar(i)}
                            disabled={loading || readOnly}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="space-y-4">
                {gatewayDiscoveryLoaded && agentGatewayTargets.length > 0 ? (
                  <div className="space-y-2">
                    <Label htmlFor="agentgateway-target">AgentGateway target</Label>
                    <p className="text-xs text-muted-foreground">
                      Pick a routed MCP target from AgentGateway. Saved Streamable HTTP MCP servers
                      always go through AgentGateway so tool access can be authorized.
                    </p>
                    <TeamPicker
                      id="agentgateway-target"
                      value={selectedAgentGatewayTargetId}
                      onChange={(targetId) => {
                        const target = agentGatewayTargets.find((candidate) => candidate.id === targetId);
                        if (target) {
                          const upstream = target.target_endpoint?.trim() || target.endpoint;
                          setEndpoint(upstream);
                          setPickedAgentGatewayUpstream(upstream);
                          setEndpointProbe(null);
                        }
                      }}
                      options={agentGatewayTargetOptions}
                      placeholder="Select an AgentGateway target"
                      searchPlaceholder="Search targets..."
                      emptyLabel="No targets match"
                      disabled={loading || readOnly}
                      hideSlugSuffix
                      contentSide="top"
                      triggerClassName="w-full font-mono"
                      contentClassName="min-w-[min(420px,90vw)]"
                      helperText={`${agentGatewayTargets.length} targets available`}
                    />
                  </div>
                ) : null}
                <div className="space-y-2">
                  <Label htmlFor="endpoint">
                    Endpoint URL <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="endpoint"
                    name="mcp-endpoint"
                    placeholder="e.g., http://localhost:3000/mcp"
                    value={endpoint}
                    onChange={(e) => {
                      const nextEndpoint = e.target.value;
                      setEndpoint(nextEndpoint);
                      setEndpointProbe(null);
                      const matchingTarget = agentGatewayTargets.find(
                        (candidate) =>
                          candidate.endpoint === nextEndpoint.trim() ||
                          candidate.target_endpoint?.trim() === nextEndpoint.trim(),
                      );
                      setPickedAgentGatewayUpstream(
                        matchingTarget?.target_endpoint?.trim() || nextEndpoint.trim(),
                      );
                    }}
                    disabled={loading || readOnly}
                    className="font-mono"
                    {...SUPPRESS_PASSWORD_MANAGER_INPUT_PROPS}
                  />
                  {transport === "http" ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void handleProbeEndpoint()}
                        disabled={loading || readOnly || endpointProbeLoading || !endpoint.trim()}
                      >
                        {endpointProbeLoading ? "Checking..." : "Check URL"}
                      </Button>
                      {endpointProbe?.suggestedUrl ? (
                        <>
                          <span className="text-xs text-muted-foreground">
                            The MCP path looks available at{" "}
                            <code className="font-mono">{endpointProbe.suggestedUrl}</code>.
                          </span>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setEndpoint(endpointProbe.suggestedUrl ?? endpoint);
                              setPickedAgentGatewayUpstream(endpointProbe.suggestedUrl ?? endpoint);
                              setEndpointProbe(null);
                            }}
                          >
                            Use suggested URL
                          </Button>
                        </>
                      ) : endpointProbe ? (
                        <span className="text-xs text-muted-foreground">
                          {endpointProbe.attempts.some((attempt) => attempt.ok)
                            ? "Endpoint responded."
                            : "Endpoint did not respond successfully."}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-4 border-t border-border/60 pt-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium">Credentials</h3>
                  <TooltipProvider delayDuration={0}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label="Credentials help"
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <Info className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent
                        side="top"
                        sideOffset={8}
                        className="max-w-sm whitespace-normal p-3 text-left font-normal leading-relaxed"
                      >
                        <div className="space-y-2">
                          <p className="font-medium text-foreground">Saved secret details</p>
                          <p>
                            Secret types such as bearer tokens or API keys describe how the
                            server uses the value. The masked preview is only a short encrypted
                            hint to help you pick the right secret; the full value stays on the
                            server and is never shown here.
                          </p>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <p className="text-xs text-muted-foreground">
                  Choose saved secrets or connected apps. Secret values stay on the server.
                </p>
                {usesAgentGatewayRouting(transport) ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Streamable HTTP MCP servers route through AgentGateway. The{" "}
                    <code className="font-mono">Authorization</code> header is reserved for the
                    caller JWT — use{" "}
                    <code className="font-mono">{MCP_PROVIDER_CREDENTIAL_HEADER}</code> for provider
                    OAuth tokens, API keys, and saved secrets.
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleAddCredentialSource}
                disabled={loading || readOnly}
              >
                <Plus className="h-4 w-4 mr-1" />
                Add Credential
              </Button>
            </div>
            {credentialSources.length > 0 && (
              <div className="space-y-2">
                {credentialSources.map((source, i) => {
                  const selectedSecret = selectedSecretOption(source, secretOptions);

                  return (
                  <div key={i} className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_2fr_auto]">
                    <Select
                      aria-label="Credential kind"
                      className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={source.kind}
                      onChange={(event) =>
                        handleUpdateCredentialKind(i, event.target.value as MCPCredentialSource["kind"])
                      }
                      disabled={readOnly}
                      {...SUPPRESS_PASSWORD_MANAGER_INPUT_PROPS}
                    >
                      <option value="secret_ref">Saved secret</option>
                      <option value="provider_connection">Connected app</option>
                    </Select>
                    <Select
                      aria-label="Credential target"
                      className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={source.target}
                      onChange={(event) => handleUpdateCredentialSource(i, "target", event.target.value)}
                      disabled={readOnly}
                      {...SUPPRESS_PASSWORD_MANAGER_INPUT_PROPS}
                    >
                      <option value="env">Environment</option>
                      <option value="header">Header</option>
                    </Select>
                    {source.target === "header" ? (
                      <div className="space-y-1">
                        <Select
                          aria-label="Credential header"
                          className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                          value={HEADER_NAME_OPTIONS.includes(source.name as (typeof HEADER_NAME_OPTIONS)[number])
                            ? source.name
                            : CUSTOM_HEADER_VALUE}
                          onChange={(event) => handleSelectCredentialHeader(i, event.target.value)}
                          disabled={readOnly}
                          {...SUPPRESS_PASSWORD_MANAGER_INPUT_PROPS}
                        >
                          {HEADER_NAME_OPTIONS.map((headerName) => (
                            <option key={headerName} value={headerName}>
                              {headerName}
                            </option>
                          ))}
                          <option value={CUSTOM_HEADER_VALUE}>Custom header</option>
                        </Select>
                        {!HEADER_NAME_OPTIONS.includes(source.name as (typeof HEADER_NAME_OPTIONS)[number]) ? (
                          <Input
                            aria-label="Custom header name"
                            placeholder="Header name"
                            value={source.name}
                            onChange={(event) => handleUpdateCredentialSource(i, "name", event.target.value)}
                            disabled={readOnly}
                            {...SUPPRESS_PASSWORD_MANAGER_INPUT_PROPS}
                          />
                        ) : null}
                        {usesAgentGatewayRouting(transport) &&
                        source.name.trim().toLowerCase() === "authorization" ? (
                          <p className="text-xs text-amber-700 dark:text-amber-400">
                            Authorization is not forwarded to the upstream MCP server via
                            AgentGateway. Use {MCP_PROVIDER_CREDENTIAL_HEADER} instead.
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <Input
                        aria-label="Credential name"
                        placeholder="GITHUB_TOKEN"
                        value={source.name}
                        onChange={(event) => handleUpdateCredentialSource(i, "name", event.target.value)}
                        disabled={readOnly}
                        {...SUPPRESS_PASSWORD_MANAGER_INPUT_PROPS}
                      />
                    )}
                    {source.kind === "secret_ref" ? (
                      <div className="space-y-1">
                        <SearchablePicker
                          options={secretOptions}
                          selected={selectedSecret}
                          onSelect={(secret) =>
                            handleUpdateCredentialSource(i, "secret_ref", secret.id)
                          }
                          getOptionKey={(secret) => secret.id}
                          getOptionLabel={secretOptionLabel}
                          getSearchText={(secret) => [
                            secret.id,
                            secretOptionLabel(secret),
                          ]}
                          placeholder={
                            secretOptions.length === 0
                              ? "No saved secrets"
                              : "Select a secret"
                          }
                          searchPlaceholder="Search secrets..."
                          emptyLabel="No secrets match"
                          ariaLabel="Secret"
                          required
                          disabled={readOnly || secretOptions.length === 0}
                          triggerClassName="h-10 text-sm"
                        />
                        {selectedSecret?.maskedPreview ? (
                          <p className="inline-flex rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                            Preview {selectedSecret.maskedPreview}
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {/*
                         * Provider connections are always caller-scoped: each
                         * caller's OWN connection for the chosen provider is
                         * used at runtime. The previous "Use this connection
                         * for all callers" (pinned) option was removed because
                         * it let one user act as another's identity upstream.
                         */}
                        <ProviderSelect
                          ariaLabel="Provider"
                          className="h-10 w-full text-sm"
                          options={[
                            ...(source.provider &&
                            !oauthConnectorOptions.some(
                              (connector) =>
                                connector.provider === source.provider,
                            )
                              ? [
                                  {
                                    provider: source.provider,
                                    name: `${source.provider} (not yet connected — set up in Credentials)`,
                                  },
                                ]
                              : []),
                            ...oauthConnectorOptions.map((connector) => ({
                              provider: connector.provider,
                              name: connector.name,
                            })),
                          ]}
                          value={source.provider ?? ""}
                          onChange={(provider) =>
                            handleUpdateCredentialSource(i, "provider", provider)
                          }
                          disabled={readOnly || oauthConnectorOptions.length === 0}
                          placeholder="Select a provider"
                        />
                        <p className="text-xs text-muted-foreground">
                          Each caller uses their own connected {" "}
                          {oauthConnectorOptions.find((c) => c.provider === source.provider)?.name ??
                            "provider"}{" "}
                          account.
                        </p>
                      </div>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Remove credential"
                      onClick={() => handleRemoveCredentialSource(i)}
                      disabled={loading || readOnly}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Test Connection */}
          {credentialSources.length > 0 && endpoint.trim() && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleProbeCredentials}
                  disabled={loading || readOnly || credentialProbeLoading || !endpoint.trim()}
                >
                  {credentialProbeLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      Testing...
                    </>
                  ) : (
                    "Test Connection"
                  )}
                </Button>
                {credentialProbe && (() => {
                  const hasMissing = credentialProbe.missingCredentials.length > 0;
                  const fullyOk = credentialProbe.ok && !hasMissing;
                  const reachableButAuth = credentialProbe.ok && hasMissing;
                  const colorClass = fullyOk
                    ? "text-green-600 dark:text-green-400"
                    : reachableButAuth
                      ? "text-yellow-600 dark:text-yellow-400"
                      : "text-destructive";
                  const label = fullyOk
                    ? `Connected (HTTP ${credentialProbe.status})`
                    : reachableButAuth
                      ? `Reachable (HTTP ${credentialProbe.status}) — credentials not resolved`
                      : credentialProbe.error
                        ? credentialProbe.error
                        : `Failed (HTTP ${credentialProbe.status})`;
                  return <span className={`text-sm font-medium ${colorClass}`}>{label}</span>;
                })()}
              </div>
              {credentialProbe && credentialProbe.missingCredentials.length > 0 && (() => {
                const providerSources = credentialSources.filter(
                  (s) => s.kind === "provider_connection" && s.provider,
                );
                const connectableProviders = providerSources.map((s) => ({
                  provider: s.provider!,
                  name:
                    oauthConnectorOptions.find((c) => c.provider === s.provider)?.name ??
                    s.provider!,
                  hasConnector: oauthConnectorOptions.some((c) => c.provider === s.provider),
                }));
                return (
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-xs text-muted-foreground">
                        Missing:{" "}
                        <span className="text-destructive font-mono">
                          {credentialProbe.missingCredentials.join(", ")}
                        </span>
                      </p>
                      {connectableProviders.map(({ provider, name, hasConnector }) =>
                        hasConnector ? (
                          <Button
                            key={provider}
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => handleOAuthConnect(provider)}
                          >
                            Connect {name}
                          </Button>
                        ) : (
                          <span key={provider} className="text-xs text-muted-foreground">
                            —{" "}
                            <a
                              href="/credentials"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline underline-offset-2 hover:text-foreground"
                            >
                              set up {name} in Credentials
                            </a>{" "}
                            first, then reconnect here.
                          </span>
                        ),
                      )}
                    </div>
                  </div>
                );
              })()}
              {credentialProbe && credentialProbe.credentialOrigins.filter((o) => o.origin !== "none").length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Resolved:{" "}
                  {credentialProbe.credentialOrigins
                    .filter((o) => o.origin !== "none")
                    .map((o, i) => (
                      <span key={i}>
                        {i > 0 ? ", " : ""}
                        <span className="font-mono">{o.name}</span>
                        {" via "}
                        <span className="font-mono">{o.origin}</span>
                        {o.provider ? ` (${o.provider})` : ""}
                      </span>
                    ))}
                </p>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
          </fieldset>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-4 border-t">
            {readOnly && (
              <span className="text-xs text-muted-foreground mr-auto">
                Config-driven — managed by configuration file
              </span>
            )}
            <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>
              {readOnly ? "Close" : "Cancel"}
            </Button>
            {!readOnly && (
              <Button type="submit" disabled={loading || !isValid}>
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {isEditing ? "Saving..." : "Creating..."}
                  </>
                ) : isEditing ? (
                  "Save Changes"
                ) : (
                  "Create Server"
                )}
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
