"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CAIPESpinner } from "@/components/ui/caipe-spinner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModelPicker } from "@/components/ui/model-picker";
import { getConfig } from "@/lib/config";
import { useAdminRole } from "@/hooks/use-admin-role";
import { requestProductTour } from "@/lib/product-tour";
import type {
  SetupWizardPayload,
  SetupWizardSelection,
} from "@/lib/setup-wizard";
import { cn } from "@/lib/utils";
import {
  Bot,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Database,
  ExternalLink,
  Gauge,
  KeyRound,
  Loader2,
  LayoutGrid,
  ListChecks,
  Minimize2,
  Maximize2,
  Minus,
  Network,
  Play,
  Plug,
  RotateCcw,
  Sparkles,
  TriangleAlert,
  X,
  XCircle,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useState } from "react";

interface ModelOption {
  _id: string;
  name: string;
  provider: string;
}

interface MCPOption {
  _id: string;
  name: string;
  description?: string;
  enabled?: boolean;
}

interface OAuthConnectorOption {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
}

interface ProviderConnectionOption {
  id: string;
  provider: string;
  status: string;
  updatedAt?: string;
  connectedAt?: string;
  expiresAt?: string;
}

interface HealthCapability {
  id: string;
  label: string;
  status: "healthy" | "degraded" | "down" | "disabled";
  detail: string;
  required: boolean;
}

interface HealthPayload {
  status: "healthy" | "degraded" | "down";
  capabilities: HealthCapability[];
  components?: Array<{
    id: string;
    label: string;
    status: "healthy" | "degraded" | "down" | "disabled";
    detail: string;
    version: string | null;
  }>;
  probes?: Array<{
    id: string;
    label: string;
    status: "healthy" | "warning" | "down";
    detail: string;
    remediation?: { href: string; label: string };
  }>;
}

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  error?: string;
}

interface ListEnvelope<T> {
  items: T[];
}

interface SetupWizardDialogProps {
  initialPayload?: SetupWizardPayload | null;
  onOpenChange: (open: boolean) => void;
  onStateChange?: (payload: SetupWizardPayload | null) => void;
  open: boolean;
  restart?: boolean;
}

const STEPS = [
  { id: 1, label: "Welcome", icon: Gauge },
  { id: 2, label: "Choose a model", icon: Sparkles },
  { id: 3, label: "Choose an agent", icon: Bot },
  { id: 4, label: "Add context", icon: Database },
  { id: 5, label: "Try your agent", icon: Play },
] as const;

const RECIPES = [
  {
    id: "sre" as const,
    title: "SRE starter",
    description: "A practical operations agent with diagnostics, knowledge search, and concise incident guidance.",
  },
  {
    id: "hello-world" as const,
    title: "Hello World",
    description: "A small general-purpose agent for validating chat and model connectivity.",
  },
  {
    id: "blank" as const,
    title: "Blank agent",
    description: "A minimal editable agent that you can shape after setup.",
  },
];


type SetupFeatureKey = "workflows" | "schedules" | "autonomous_agents" | "apps";

const SETUP_FEATURES: Array<{
  key: SetupFeatureKey;
  label: string;
  description: string;
  deployment: string;
  docs: string;
  href: string;
  icon: typeof Workflow;
}> = [
  {
    key: "workflows",
    label: "Workflows",
    description: "Run multi-step agent workflows from the Workflows workspace.",
    deployment: "Requires WORKFLOWS_ENABLED and WORKFLOW_RUNNER_ENABLED.",
    docs: "https://caipe.io/docs/features/workflows/",
    href: "/workflows",
    icon: Workflow,
  },
  {
    key: "schedules",
    label: "Schedules",
    description: "Run an agent on a recurring schedule or trigger.",
    deployment: "Requires the Scheduler deployment and SCHEDULER_ENABLED.",
    docs: "https://caipe.io/docs/architecture/scheduler/#enable-the-scheduler",
    href: "/schedules",
    icon: CalendarClock,
  },
  {
    key: "autonomous_agents",
    label: "Autonomous Agents",
    description: "Let agents run on cron, interval, and webhook triggers.",
    deployment: "Requires the autonomous-agents service and ENABLE_AUTONOMOUS_AGENTS.",
    docs: "https://caipe.io/docs/architecture/autonomous-agents/",
    href: "/autonomous",
    icon: Sparkles,
  },
  {
    key: "apps",
    label: "Apps",
    description: "Expose the deployment-owned External Apps catalog.",
    deployment: "Enable AGENTIC_APPS_INSTALL_ENABLED and supply an app catalog with AGENTIC_APPS_CONFIG_PATH.",
    docs: "https://caipe.io/docs/features/agentic-apps/",
    href: "/apps",
    icon: LayoutGrid,
  },
];

const SETUP_CONNECTIONS = [
  {
    provider: "github",
    label: "GitHub",
    description: "Repository and pull-request access for developer and SRE agents.",
  },
  {
    provider: "notion",
    label: "Notion",
    description: "Search pages and databases through the Notion MCP server.",
  },
] as const;

const MODEL_PROVIDER_GUIDANCE = [
  {
    label: "OpenAI-compatible endpoint",
    description: "Connect to any OpenAI-compatible API endpoint, including LiteLLM.",
    detail: "Configure the endpoint, API key, and model routing in Model providers.",
    icon: Plug,
  },
  {
    label: "Anthropic API",
    description: "Use Anthropic models directly with an Anthropic API key.",
    detail: "Keep the key in deployment configuration; this wizard never stores provider secrets.",
    icon: Sparkles,
  },
  {
    label: "AWS Bedrock",
    description: "Use Bedrock models with static keys or workload identity.",
    detail: "Recommended for Kubernetes: an IAM role, service account, IRSA, or EKS Pod Identity.",
    icon: Cloud,
  },
] as const;

const SETUP_INTEGRATIONS = [
  {
    id: "slack",
    label: "Slack",
    description: "Bring your team channels and bot conversations into the platform.",
    href: "/admin/integrations/slack",
  },
  {
    id: "webex",
    label: "Webex",
    description: "Connect spaces and the Webex bot for team-friendly agent access.",
    href: "/admin/integrations/webex",
  },
] as const;

function deploymentFeatureDefaults(): Record<SetupFeatureKey, boolean> {
  return {
    workflows: Boolean(getConfig("workflowsEnabled") && getConfig("workflowRunnerEnabled")),
    schedules: Boolean(getConfig("schedulerEnabled")),
    autonomous_agents: Boolean(getConfig("autonomousAgentsEnabled")),
    apps: Boolean(getConfig("agenticAppsEnabled")),
  };
}

function messageFromPayload(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
    return payload.error;
  }
  return fallback;
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => null);
  if (response.status === 401) throw new Error("Your session has expired. Sign in again, then resume setup from Admin → Platform configuration → Setup Wizard.");
  if (!response.ok) throw new Error(messageFromPayload(payload, `Request failed (${response.status})`));
  return payload as T;
}

async function optionalJsonRequest<T>(url: string): Promise<T | null> {
  try {
    return await jsonRequest<T>(url);
  } catch {
    // Credentials are optional. A deployment with that feature disabled must
    // still be able to complete the first-install wizard.
    return null;
  }
}

async function healthRequest(): Promise<HealthPayload | null> {
  try {
    const response = await fetch("/api/platform/health?diagnostics=1", { cache: "no-store" });
    const payload = await response.json();
    return payload && Array.isArray(payload.capabilities) ? payload as HealthPayload : null;
  } catch {
    return null;
  }
}

function setupStatusLabel(status: SetupWizardPayload["state"]["status"]): string {
  if (status === "completed") return "Completed";
  if (status === "dismissed") return "Skipped";
  if (status === "in_progress") return "In progress";
  return "Not started";
}

function recipeAgent(recipe: SetupWizardSelection["recipe_id"], model: ModelOption, mcpIds: string[]) {
  const allowedTools = Object.fromEntries(mcpIds.map((id) => [id, true]));
  if (recipe === "hello-world") {
    return {
      id: "agent-hello-world-starter",
      body: {
        name: "Hello World Starter",
        description: "A small validation agent created by the first-time setup wizard.",
        system_prompt: "You are a friendly assistant used to validate this platform installation. Reply clearly and concisely.",
        allowed_tools: allowedTools,
        builtin_tools: { current_datetime: { enabled: true } },
        model: { id: model._id, provider: model.provider },
        visibility: "global",
        subagents: [],
        skills: [],
        enabled: true,
      },
    };
  }
  if (recipe === "blank") {
    return {
      id: "agent-starter-agent",
      body: {
        name: "Starter Agent",
        description: "A minimal agent created by the first-time setup wizard.",
        system_prompt: "You are a helpful assistant. Be concise, accurate, and ask for clarification when needed.",
        allowed_tools: allowedTools,
        builtin_tools: { current_datetime: { enabled: true } },
        model: { id: model._id, provider: model.provider },
        visibility: "global",
        subagents: [],
        skills: [],
        enabled: true,
      },
    };
  }
  return {
    id: "agent-sre-starter",
    body: {
      name: "SRE Starter",
      description: "Starter site reliability agent created by the first-time setup wizard.",
      system_prompt: "You are a site reliability engineering assistant. Diagnose methodically, state assumptions, prefer safe read-only checks, summarize evidence, and provide concise remediation steps. Never claim an action succeeded without evidence.",
      allowed_tools: allowedTools,
      builtin_tools: {
        current_datetime: { enabled: true },
        fetch_url: { enabled: true, allowed_domains: "*" },
      },
      model: { id: model._id, provider: model.provider },
      visibility: "global",
      subagents: [],
      skills: [],
      enabled: true,
    },
  };
}

export function SetupWizardDialog({
  initialPayload,
  onOpenChange,
  onStateChange,
  open,
  restart = false,
}: SetupWizardDialogProps): React.ReactElement {
  const router = useRouter();
  const [payload, setPayload] = useState<SetupWizardPayload | null>(initialPayload ?? null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [mcpServers, setMcpServers] = useState<MCPOption[]>([]);
  const [oauthConnectors, setOauthConnectors] = useState<OAuthConnectorOption[]>([]);
  const [providerConnections, setProviderConnections] = useState<ProviderConnectionOption[]>([]);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [step, setStep] = useState(1);
  const [selection, setSelection] = useState<SetupWizardSelection>({
    recipe_id: "sre",
    mcp_server_ids: [],
    enable_knowledge_base: false,
    enabled_features: deploymentFeatureDefaults(),
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runningTest, setRunningTest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testConversationId, setTestConversationId] = useState<string | null>(null);
  const [showAddModel, setShowAddModel] = useState(false);
  const [newModel, setNewModel] = useState({ model_id: "", name: "", provider: "" });
  const [leaving, setLeaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [contextSection, setContextSection] = useState("accounts");

  // Save the current draft before handing control to another workspace. Keeping
  // this on the dialog also covers links inside shared guidance components.
  const minimize = async (href?: string) => {
    if (saving || runningTest || leaving) return;
    if (loading || !payload) {
      onOpenChange(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const state = await patchState({ action: payload?.state.status === "completed" ? "complete" : "progress", current_step: step, selection });
      const savedPayload = payload ? { ...payload, state } : null;
      if (savedPayload) onStateChange?.(savedPayload);
      window.dispatchEvent(new Event("caipe:platform-features-updated"));
      setLeaving(true);
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      window.setTimeout(() => {
        onOpenChange(false);
        window.dispatchEvent(new CustomEvent("caipe:setup-minimized", { detail: savedPayload }));
        setLeaving(false);
        if (href?.startsWith("/api/")) window.location.assign(href);
        else if (href) router.push(href);
      }, reducedMotion ? 0 : 320);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save your place. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const exitSetup = async () => {
    if (saving || runningTest || leaving || loading || !payload) return;
    setSaving(true);
    setError(null);
    try {
      const state = await patchState({ action: "dismiss", current_step: step, selection });
      const savedPayload = { ...payload, state };
      onStateChange?.(savedPayload);
      window.dispatchEvent(new Event("caipe:platform-features-updated"));
      onOpenChange(false);
    } catch (exitError) {
      setError(exitError instanceof Error ? exitError.message : "Could not exit setup. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleTaskLink = (event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
    if (!anchor || anchor.target === "_blank" || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const url = new URL(anchor.href, window.location.origin);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    event.stopPropagation();
    void minimize(`${url.pathname}${url.search}${url.hash}`);
  };

  const patchState = useCallback(async (body: Record<string, unknown>) => {
    const result = await jsonRequest<ApiEnvelope<{ state: SetupWizardPayload["state"] }>>(
      "/api/admin/setup-wizard",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    setPayload((current) => current ? { ...current, state: result.data.state } : current);
    return result.data.state;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [setupResponse, healthResponse, modelResponse, mcpResponse, connectionsResponse, connectorsResponse] = await Promise.all([
        jsonRequest<ApiEnvelope<SetupWizardPayload>>("/api/admin/setup-wizard"),
        healthRequest(),
        jsonRequest<ApiEnvelope<ListEnvelope<ModelOption>>>("/api/llm-models?page_size=100"),
        jsonRequest<ApiEnvelope<ListEnvelope<MCPOption>>>("/api/mcp-servers?page_size=100"),
        optionalJsonRequest<ApiEnvelope<ProviderConnectionOption[]>>("/api/credentials/connections"),
        optionalJsonRequest<ApiEnvelope<OAuthConnectorOption[]>>("/api/credentials/oauth-connectors"),
      ]);
      const nextPayload = setupResponse.data;
      const nextModels = modelResponse.data.items ?? [];
      const nextMcpServers = (mcpResponse.data.items ?? []).filter((server) => server.enabled !== false);
      setPayload(nextPayload);
      setHealth(healthResponse);
      setModels(nextModels);
      setMcpServers(nextMcpServers);
      setProviderConnections(connectionsResponse?.data ?? []);
      setOauthConnectors(connectorsResponse?.data ?? []);
      const saved = nextPayload.state.selection;
      const defaultModel = saved?.model_id
        ? nextModels.find((model) => model._id === saved.model_id)
        : nextModels[0];
      const defaults = nextMcpServers
        .filter((server) => server._id === "netutils" || server._id === "knowledge-base")
        .map((server) => server._id);
      const defaultFeatures = deploymentFeatureDefaults();
      setSelection({
        recipe_id: saved?.recipe_id ?? "sre",
        model_id: defaultModel?._id,
        model_provider: defaultModel?.provider,
        mcp_server_ids: saved?.mcp_server_ids ?? defaults,
        enable_knowledge_base: saved?.enable_knowledge_base
          ?? defaults.includes("knowledge-base"),
        enabled_features: {
          ...defaultFeatures,
          ...(saved?.enabled_features ?? {}),
        },
      });
      setStep(restart ? 1 : nextPayload.state.current_step);
      if (restart) {
        const state = await patchState({ action: "reset" });
        setPayload({ ...nextPayload, state });
      } else if (nextPayload.state.status === "not_started" || nextPayload.state.status === "dismissed") {
        const state = await patchState({
          action: "start",
          current_step: nextPayload.state.current_step,
        });
        setPayload({ ...nextPayload, state });
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load setup information");
    } finally {
      setLoading(false);
    }
  }, [patchState, restart]);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  useEffect(() => {
    if (!open) return;
    const refreshConnections = () => {
      void Promise.all([
        optionalJsonRequest<ApiEnvelope<ProviderConnectionOption[]>>("/api/credentials/connections"),
        optionalJsonRequest<ApiEnvelope<OAuthConnectorOption[]>>("/api/credentials/oauth-connectors"),
      ]).then(([connectionsResponse, connectorsResponse]) => {
        const connections = connectionsResponse?.data ?? [];
        setProviderConnections(connections);
        setOauthConnectors(connectorsResponse?.data ?? []);
        setPayload((current) => current
          ? {
              ...current,
              inventory: {
                ...current.inventory,
                connected_credentials: connections.filter((connection) => connection.status === "connected").length,
              },
            }
          : current);
      });
    };
    const handleOAuthMessage = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.data?.type === "caipe.oauth.connection") {
        refreshConnections();
      }
    };
    window.addEventListener("message", handleOAuthMessage);
    const channel = typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel("caipe.oauth.connection");
    channel?.addEventListener("message", refreshConnections);
    return () => {
      window.removeEventListener("message", handleOAuthMessage);
      channel?.removeEventListener("message", refreshConnections);
      channel?.close();
    };
  }, [open]);

  const addModel = useCallback(async () => {
    setError(null);
    setSaving(true);
    try {
      const result = await jsonRequest<ApiEnvelope<ModelOption>>("/api/llm-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newModel),
      });
      setModels((current) => [...current, result.data]);
      setSelection((current) => ({ ...current, model_id: result.data._id, model_provider: result.data.provider }));
      setNewModel({ model_id: "", name: "", provider: "" });
      setShowAddModel(false);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Could not add model");
    } finally {
      setSaving(false);
    }
  }, [newModel]);

  const selectedModel = useMemo(
    () => models.find((model) => model._id === selection.model_id),
    [models, selection.model_id],
  );
  const requiredHealthFailure = health?.capabilities.some(
    (capability) => capability.required && capability.status === "down",
  ) ?? false;
  const connectedProviders = new Set(
    providerConnections
      .filter((connection) => connection.status === "connected")
      .map((connection) => connection.provider),
  );

  const persistProgress = async (nextStep: number, skippedStep?: number) => {
    setSaving(true);
    setError(null);
    try {
      const nextSelection = skippedStep === 4
        ? { ...selection, mcp_server_ids: [], enable_knowledge_base: false }
        : selection;
      const completed = [...new Set([...(payload?.state.completed_steps ?? []).filter((id) => id !== skippedStep), ...(skippedStep ? [] : [step])])];
      const skipped = skippedStep
        ? [...new Set([...(payload?.state.skipped_steps ?? []), skippedStep])]
        : (payload?.state.skipped_steps ?? []).filter((id) => id !== step);
      await patchState({
        action: "progress",
        current_step: nextStep,
        completed_steps: completed,
        skipped_steps: skipped,
        selection: nextSelection,
      });
      setSelection(nextSelection);
      window.dispatchEvent(new Event("caipe:platform-features-updated"));
      setStep(nextStep);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save setup progress");
    } finally {
      setSaving(false);
    }
  };

  const createAndTest = async () => {
    if (!selectedModel) {
      setError("Select a model before creating the starter agent.");
      setStep(2);
      return;
    }
    setRunningTest(true);
    setError(null);
    setTestResult(null);
    try {
      const selectedMcp = [...new Set([
        ...(selection.mcp_server_ids ?? []),
        ...(selection.enable_knowledge_base && mcpServers.some((server) => server._id === "knowledge-base")
          ? ["knowledge-base"]
          : []),
      ])];
      const agent = recipeAgent(selection.recipe_id ?? "sre", selectedModel, selectedMcp);
      let agentId = agent.id;
      if (agent.body) {
        const createResponse = await fetch("/api/dynamic-agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(agent.body),
        });
        const createPayload = await createResponse.json().catch(() => null);
        if (!createResponse.ok && createResponse.status !== 409) {
          throw new Error(messageFromPayload(createPayload, "Could not create the starter agent"));
        }
        if (createResponse.ok && createPayload?.data?._id) agentId = createPayload.data._id;
      }

      const conversationPayload = await jsonRequest<ApiEnvelope<{
        conversation: { _id: string };
      }>>("/api/chat/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Setup wizard smoke test",
          client_type: "webui",
          agent_id: agentId,
          tags: ["setup-wizard"],
        }),
      });
      const invokePayload = await jsonRequest<Record<string, unknown>>("/api/v1/chat/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Reply with a brief confirmation that the starter agent is ready.",
          conversation_id: conversationPayload.data.conversation._id,
          agent_id: agentId,
        }),
      });
      const content = typeof invokePayload.content === "string"
        ? invokePayload.content
        : "The agent returned a successful response.";
      setTestConversationId(conversationPayload.data.conversation._id);
      setTestResult(content);
      await patchState({
        action: "complete",
        current_step: 5,
        completed_steps: [1, 2, 3, 4, 5],
        selection: { ...selection, mcp_server_ids: selectedMcp },
        created_agent_id: agentId,
        smoke_test: { status: "passed", detail: content },
      });
    } catch (testError) {
      const detail = testError instanceof Error ? testError.message : "Starter agent test failed";
      setError(detail);
      await patchState({
        action: "progress",
        current_step: 5,
        selection,
        smoke_test: { status: "failed", detail },
      }).catch(() => undefined);
    } finally {
      setRunningTest(false);
    }
  };

  const canContinue = !loading && (step !== 2 || Boolean(selectedModel));

  const readinessCapabilities = (health?.capabilities ?? []).filter((capability) =>
    ["chat-runtime", "dynamic-agents", "knowledge-bases", "authentication"].includes(capability.id),
  );
  const readinessProbes = health?.probes?.filter((probe) => probe.id === "rebac-migrations") ?? [];
  const migrationProbe = readinessProbes[0];
  const readinessChecks = readinessCapabilities.length + readinessProbes.length;
  const healthyReadinessChecks = readinessCapabilities.filter((capability) => capability.status === "healthy").length
    + readinessProbes.filter((probe) => probe.status === "healthy").length;
  const completedSteps = (payload?.state.completed_steps ?? []).filter((id) => !(payload?.state.skipped_steps ?? []).includes(id));
  const progress = Math.round(completedSteps.filter((id) => id !== 4).length / 4 * 100);

  const closeCompleted = () => {
    onOpenChange(false);
    onStateChange?.(null);
    requestProductTour();
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen && !saving && !runningTest) {
        if (payload?.state.status === "completed") closeCompleted();
        else void minimize();
      }
    }}>
      <DialogContent
        onClickCapture={handleTaskLink}
        aria-busy={saving || leaving}
        className={cn("setup-dialog h-[min(760px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] min-h-0 overflow-hidden rounded-2xl p-0 transition-[max-width] duration-200 motion-reduce:transition-none", expanded ? "max-w-none" : "max-w-5xl", leaving && "setup-minimizing pointer-events-none")}
      >
        <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[220px_1fr]">
          <aside className="border-b bg-muted/25 p-4 md:border-b-0 md:border-r">
            <div className="mb-5 flex items-center gap-2">
              <span className="animate-pulse-glow rounded-lg bg-primary/10 p-2 text-primary"><Sparkles className="h-5 w-5" /></span>
              <div>
                <p className="font-semibold">Platform setup</p>
                <p className="text-xs text-muted-foreground">First working agent</p>
              </div>
            </div>
            <ol className="grid grid-cols-5 gap-2 md:grid-cols-1">
              {STEPS.map((item) => {
                const Icon = item.icon;
                const complete = completedSteps.includes(item.id);
                const active = item.id === step;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-all duration-300 md:text-sm",
                        active ? "bg-primary/10 font-medium text-primary shadow-[0_0_24px_-14px_hsl(var(--primary))]" : "text-muted-foreground hover:bg-muted",
                      )}
                      onClick={() => setStep(item.id)}
                      disabled={saving || runningTest || leaving}
                      aria-label={item.label}
                      aria-current={active ? "step" : undefined}
                    >
                      <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full border transition-all duration-300", complete && "border-primary bg-primary text-primary-foreground", active && !complete && "animate-pulse-gentle border-primary")}>
                        {complete ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
                      </span>
                      <span className="hidden md:inline">{item.label}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <div className="mt-6 hidden md:block">
              <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Basic setup progress</span>
                <span>{progress}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-primary via-cyan-400 to-violet-500 transition-[width] duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Start with one model and one agent. Add tools and automation whenever you’re ready.</p>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Your place is saved when you leave. Return with <strong>Resume setup</strong> or Admin → Platform configuration → Setup Wizard.</p>
            </div>
          </aside>

          <section className="flex min-h-0 flex-col">
            <DialogHeader className="relative border-b px-6 py-4 pr-36 text-left">
              <Button type="button" size="icon" variant="ghost" className="absolute right-20 top-2" aria-label={expanded ? "Restore setup width" : "Expand setup width"} aria-pressed={expanded} title={expanded ? "Restore width" : "Expand width"} onClick={() => setExpanded((current) => !current)}>{expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</Button>
              <Button type="button" size="icon" variant="ghost" className="absolute right-11 top-2" aria-label="Minimize setup" title="Save and minimize" onClick={() => void minimize()} disabled={saving || runningTest || leaving}><Minus className="h-4 w-4" /></Button>
              <DialogTitle>{STEPS[step - 1].label}</DialogTitle>
              <DialogDescription>
                {step === 1 && "A few small steps to your first working agent."}
                {step === 2 && "Decide which AI will answer for your first agent."}
                {step === 3 && "Give your agent a job. A recipe is a starting set of instructions."}
                {step === 4 && "Optional · Connect information or tools only if your first task needs them."}
                {step === 5 && "Check that your agent and its AI connection work together."}
              </DialogDescription>
            </DialogHeader>

            <div key={step} className="setup-step min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5 [scrollbar-width:thin]">
              {loading ? (
                <div className="grid min-h-72 place-items-center"><CAIPESpinner message="Inspecting this deployment..." /></div>
              ) : (
                <>
                  {error && (
                    <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{error}</span>
                    </div>
                  )}

                  {step === 1 && (
                    <div className="space-y-3">
                      <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/15 via-background to-violet-500/10 p-6">
                        <div className="pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full bg-primary/15 blur-3xl animate-pulse-glow" />
                        <div className="relative flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className="text-xs font-medium uppercase tracking-widest text-primary">Welcome to CAIPE</p>
                            <p className="mt-2 text-2xl font-semibold tracking-tight">Your first agent starts here.</p>
                            <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">An agent is an AI assistant with a job and, optionally, tools. We’ll help you create one and try a first conversation.</p>
                          </div>
                          {readinessChecks > 0 && (
                            <div className="flex items-center gap-1.5 rounded-full border bg-background/70 px-2.5 py-1 text-[11px] font-medium">
                              <span className={cn("h-2 w-2 rounded-full", healthyReadinessChecks === readinessChecks ? "animate-pulse bg-emerald-500" : "bg-amber-500")} />
                              {healthyReadinessChecks}/{readinessChecks} checks ready
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-3">
                        {[{ icon: Sparkles, title: "1. Choose its AI", text: "Use an existing connection or bring your provider." }, { icon: Bot, title: "2. Give it a job", text: "Choose starter instructions you can change later." }, { icon: Play, title: "3. Say hello", text: "Create the agent and check a real response." }].map((item) => (
                          <div key={item.title} className="rounded-xl border bg-card/60 p-4"><item.icon className="mb-3 h-5 w-5 text-primary" /><p className="text-sm font-medium">{item.title}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.text}</p></div>
                        ))}
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/10 p-4">
                        <p className="text-sm text-muted-foreground">
                          {!health ? "Platform health is unavailable. Check it before testing." : requiredHealthFailure ? "A required service needs attention before your first test." : "Review service status and deployment details in Platform Health."}
                        </p>
                        <Button asChild variant="outline" size="sm">
                          <Link href="/admin/operations/health">Open Platform Health<ChevronRight className="ml-1 h-4 w-4" /></Link>
                        </Button>
                      </div>
                      {migrationProbe && (
                        <div className={cn(
                          "flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4",
                          migrationProbe.status === "healthy"
                            ? "border-emerald-500/20 bg-emerald-500/5"
                            : "border-amber-500/30 bg-amber-500/5",
                        )}>
                          <div className="flex items-start gap-3">
                            <KeyRound className={cn("mt-0.5 h-5 w-5 shrink-0", migrationProbe.status === "healthy" ? "text-emerald-500" : "text-amber-500")} />
                            <div>
                              <p className="text-sm font-semibold">Keycloak &amp; RBAC migration</p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {migrationProbe.status === "healthy" ? "Authorization schema is current." : migrationProbe.detail}
                              </p>
                            </div>
                          </div>
                          <Button asChild variant="outline" size="sm">
                            <Link href={migrationProbe.remediation?.href ?? "/admin/security/access-operations?operationsTab=migrations"}>
                              {migrationProbe.status === "healthy" ? "View migration status" : "Review migration"}<ChevronRight className="ml-1 h-4 w-4" />
                            </Link>
                          </Button>
                        </div>
                      )}
                      <details open className="group animate-fade-in rounded-xl border bg-muted/10 p-3">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
                          <span className="flex items-center gap-2 text-sm font-semibold"><ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" /> Optional capabilities</span>
                          <span className="text-[11px] text-muted-foreground">Configure later</span>
                        </summary>
                        <div className="mt-2 space-y-2.5">
                        <div>
                          <p className="text-xs text-muted-foreground">Choose what appears in your navigation. These are optional; you can return here after your first conversation.</p>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {SETUP_FEATURES.map((feature) => {
                            const Icon = feature.icon;
                            const deployed = deploymentFeatureDefaults()[feature.key];
                            const enabled = selection.enabled_features?.[feature.key] ?? deployed;
                            return (
                              <div
                                key={feature.key}
                                className={cn(
                                  "flex items-start gap-2.5 rounded-lg border p-2.5 transition-colors",
                                  deployed ? "hover:bg-muted/40" : "bg-muted/20",
                                )}
                              >
                                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-center justify-between gap-2">
                                    <span className="text-sm font-medium">{feature.label}</span>
                                    <input
                                      type="checkbox"
                                      aria-label={`Show ${feature.label} in navigation`}
                                      checked={deployed && enabled}
                                      disabled={!deployed || saving}
                                      onChange={(event) => setSelection((current) => ({
                                        ...current,
                                        enabled_features: {
                                          ...(current.enabled_features ?? deploymentFeatureDefaults()),
                                          [feature.key]: event.target.checked,
                                        },
                                      }))}
                                      className="h-4 w-4 accent-primary"
                                    />
                                  </span>
                                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{feature.description}</span>
                                  <span className="mt-1 block text-[10px] text-muted-foreground">
                                    {deployed ? "Available · Show in navigation" : "Not enabled in this deployment"}
                                  </span>
                                  {deployed && (
                              <Link className="mt-0.5 inline-block text-[11px] text-primary hover:underline" href={feature.href} onClick={() => onOpenChange(false)}>
                                      Open {feature.label}
                                    </Link>
                                  )}
                                  {!deployed && (
                                    <details className="mt-2 text-xs">
                                      <summary className="cursor-pointer text-primary">How to enable</summary>
                                      <p className="mt-2 leading-relaxed text-muted-foreground">Ask your deployment administrator to enable this feature, then restart or redeploy CAIPE UI. {feature.deployment}</p>
                                      <a className="mt-2 inline-flex items-center gap-1 text-primary hover:underline" href={feature.docs} target="_blank" rel="noreferrer">Read deployment guide<ExternalLink className="h-3 w-3" /><span className="sr-only"> (opens in a new tab)</span></a>
                                    </details>
                                  )}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          Workflows include a short guided explanation in the Workflows workspace. Apps require a deployment-owned catalog before they can be enabled.
                        </p>
                      </div>
                      </details>
                      {requiredHealthFailure && (
                        <p className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
                          <TriangleAlert className="h-4 w-4" /> A required service is down. Fix it before the final smoke test.
                        </p>
                      )}
                    </div>
                  )}

                  {step === 2 && (
                    <div className="space-y-4">
                      <div>
                        <h3 className="text-lg font-semibold">Which AI should your agent use?</h3>
                        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">A model is the AI that reads your messages and writes your agent’s replies. This choice applies to the starter agent, not to every agent in CAIPE.</p>
                      </div>
                      {models.length > 0 ? (
                        <div className="space-y-4 rounded-xl border border-primary/30 bg-primary/5 p-5">
                          <div className="flex items-start gap-3">
                            <Sparkles className="mt-1 h-5 w-5 shrink-0 text-primary" />
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-muted-foreground">For your first agent</p>
                              <p className="mt-1 break-words text-lg font-semibold">{selectedModel?.name ?? "Choose an AI model"}</p>
                              <p className="mt-2 text-sm text-muted-foreground">Already registered in this deployment. Provider access has not been verified by this selection—we’ll check it when you try your agent.</p>
                            </div>
                          </div>
                          <details>
                            <summary className="cursor-pointer text-sm font-medium text-primary">Change model</summary>
                            <div className="mt-3 space-y-2">
                              <ModelPicker
                                options={models.map((model) => ({ model_id: model._id, name: model.name, provider: model.provider }))}
                                modelId={selection.model_id}
                                modelProvider={selection.model_provider}
                                onChange={(model_id, model_provider) => setSelection((current) => ({ ...current, model_id, model_provider }))}
                                ariaLabel="AI model for your first agent"
                                disabled={saving}
                              />
                              <p className="text-xs text-muted-foreground">Choose a model your administrator has configured. You can change it later in Custom Agents.</p>
                            </div>
                          </details>
                        </div>
                      ) : (
                        <div className="rounded-xl border border-dashed p-5">
                          <p className="font-semibold">Let’s connect your first AI provider</p>
                          <p className="mt-2 text-sm text-muted-foreground">No model is registered yet. First configure a provider’s endpoint and access, then register a model it supports. If someone manages this deployment for you, ask them to help with this connection.</p>
                        </div>
                      )}
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
                        <div className="max-w-sm">
                          <p className="text-sm font-semibold">{models.length ? "Need a different AI provider?" : "Connect a provider"}</p>
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Use OpenAI, an OpenAI-compatible service such as LiteLLM, Anthropic, or AWS Bedrock. Setup saves and minimizes while you configure access; use Resume setup to return.</p>
                        </div>
                        <Button asChild size="sm" variant={models.length ? "outline" : "default"}><Link href="/dynamic-agents?tab=model-providers">Configure provider access<ChevronRight className="ml-1 h-4 w-4" /></Link></Button>
                      </div>
                      <details className="rounded-xl border p-4">
                        <summary className="cursor-pointer text-sm font-medium">Provider help & advanced model registration</summary>
                        <div className="mt-4 space-y-4">
                          <ModelProviderGuide />
                          <p className="text-xs leading-relaxed text-muted-foreground">Already configured provider access? Register its model here. This adds a catalog entry only; it does not save an API key, configure an endpoint, or prove that the model works.</p>
                          {showAddModel ? (
                            <div className="space-y-3">
                              <div><Label htmlFor="setup-model-id">Model ID</Label><Input id="setup-model-id" placeholder="Provider’s exact model ID" value={newModel.model_id} onChange={(e) => setNewModel({ ...newModel, model_id: e.target.value })} /></div>
                              <div><Label htmlFor="setup-model-name">Display name</Label><Input id="setup-model-name" placeholder="A name you’ll recognize" value={newModel.name} onChange={(e) => setNewModel({ ...newModel, name: e.target.value })} /></div>
                              <div><Label htmlFor="setup-model-provider">Provider</Label><Input id="setup-model-provider" placeholder="openai or anthropic" value={newModel.provider} onChange={(e) => setNewModel({ ...newModel, provider: e.target.value })} /></div>
                              <div className="flex gap-2"><Button onClick={() => void addModel()} disabled={saving || !newModel.model_id || !newModel.name || !newModel.provider}>{saving ? "Adding..." : "Add model"}</Button><Button variant="outline" onClick={() => setShowAddModel(false)}>Cancel</Button></div>
                            </div>
                          ) : <Button variant="outline" onClick={() => setShowAddModel(true)}>{models.length ? "Add another model" : "Add a model"}</Button>}
                        </div>
                      </details>
                    </div>
                  )}

                  {step === 3 && (
                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/10 p-3">
                        <div>
                          <p className="text-sm font-semibold">What would you like your agent to help with?</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">Pick starter instructions below. SRE means site reliability engineering—help with troubleshooting and incidents. For the simplest connection test, choose Hello World.</p>
                        </div>
                        <Button asChild size="sm" variant="outline">
                          <Link href="/dynamic-agents" onClick={() => onOpenChange(false)}>
                            Open Custom Agents<ExternalLink className="ml-2 h-3.5 w-3.5" />
                          </Link>
                        </Button>
                      </div>
                      <div className="grid gap-3 lg:grid-cols-3">
                        {RECIPES.map((recipe) => (
                          <button
                            key={recipe.id}
                            type="button"
                            onClick={() => setSelection((current) => ({ ...current, recipe_id: recipe.id }))}
                            aria-pressed={selection.recipe_id === recipe.id}
                            className={cn(
                              "rounded-xl border p-5 text-left transition-colors",
                              selection.recipe_id === recipe.id ? "border-primary bg-primary/5" : "hover:bg-muted/40",
                            )}
                          >
                            <div className="mb-4 flex items-center justify-between">
                              <Bot className="h-6 w-6 text-primary" />
                              {recipe.id === "sre" && <Badge variant="secondary">Recommended</Badge>}
                            </div>
                            <p className="font-semibold">{recipe.title}</p>
                            <p className="mt-2 text-sm text-muted-foreground">{recipe.description}</p>
                          </button>
                        ))}
                      </div>
                      <p className="rounded-xl bg-primary/5 p-4 text-sm text-muted-foreground">{selection.recipe_id === "sre" ? "Your SRE starter can help reason through incidents. Connect operational tools later for live diagnostics." : selection.recipe_id === "hello-world" ? "A simple starting point: check that your model responds before adding tools or specialist instructions." : "Start with minimal instructions, then customize your agent in the agent workspace."} Nothing is created until you run the test.</p>
                    </div>
                  )}

                  {step === 4 && (
                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
                        <div className="max-w-md"><p className="text-sm font-semibold">Does your first task need outside information?</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">For a first conversation, you can skip this step. Accounts authorize access, tools let the agent act, knowledge supplies searchable documents, and team channels bring it to Slack or Webex.</p></div>
                        <Button variant="outline" size="sm" onClick={() => void persistProgress(5, 4)} disabled={saving}>Try without extras<ChevronRight className="ml-1 h-4 w-4" /></Button>
                      </div>
                      <nav aria-label="Optional agent context" className="flex flex-wrap gap-2">
                        {[{ id: "accounts", label: "Accounts", icon: KeyRound }, { id: "tools", label: "Tools", icon: Plug }, { id: "knowledge", label: "Knowledge", icon: Database }, { id: "team", label: "Team channels", icon: Network }].map((item) => <Button key={item.id} size="sm" variant={contextSection === item.id ? "default" : "outline"} aria-pressed={contextSection === item.id} onClick={() => setContextSection(item.id)}><item.icon className="mr-2 h-4 w-4" />{item.label}</Button>)}
                      </nav>
                      {contextSection === "accounts" && (
                      <div className="space-y-3 rounded-xl border bg-muted/10 p-4">
                        <div className="flex items-start gap-3">
                          <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                          <div>
                            <p className="font-medium">Connect credentials</p>
                            <p className="text-sm text-muted-foreground">
                              Connect the accounts your agent should use. Tokens are stored by the credential service and are never saved in this wizard.
                            </p>
                          </div>
                        </div>
                        {oauthConnectors.length === 0 ? (
                          <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                            <p>No user OAuth connectors are configured in this deployment yet. An administrator can add GitHub, Notion, Webex, or another provider before you connect an account.</p>
                            <Link className="mt-2 inline-flex items-center text-primary hover:underline" href="/admin/platform/credentials?credentialsTab=oauth-providers" onClick={() => onOpenChange(false)}>
                              Configure connected apps <ExternalLink className="ml-1 h-3.5 w-3.5" />
                            </Link>
                          </div>
                        ) : (
                          <div className="grid gap-2 sm:grid-cols-2">
                            {SETUP_CONNECTIONS.map((entry) => {
                              const connected = connectedProviders.has(entry.provider);
                              const available = oauthConnectors.some((connector) => connector.provider === entry.provider && connector.enabled);
                              return (
                                <div key={entry.provider} className="flex items-start justify-between gap-3 rounded-lg border p-3">
                                  <div className="flex min-w-0 gap-2">
                                    <Plug className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                                    <div className="min-w-0">
                                      <p className="text-sm font-medium">{entry.label}</p>
                                      <p className="text-xs text-muted-foreground">{entry.description}</p>
                                      <p className={cn("mt-1 text-xs", connected ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                                        {!available ? "Not enabled" : connected ? "Connected" : "Not connected"}
                                      </p>
                                    </div>
                                  </div>
                                  {available && !connected && (
                                    <Button asChild size="sm" variant="outline">
                                      <Link href={`/api/credentials/oauth/${entry.provider}/connect`} onClick={() => onOpenChange(false)}>Connect</Link>
                                    </Button>
                                  )}
                                  {!available && <Link className="shrink-0 text-xs text-primary hover:underline" href="/admin/platform/credentials?credentialsTab=oauth-providers">Enable connector</Link>}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        <div className="flex flex-wrap items-center gap-3">
                          <Button asChild size="sm" variant="outline">
                            <Link href="/credentials/connections" onClick={() => onOpenChange(false)}>Manage connected credentials<ExternalLink className="ml-2 h-3.5 w-3.5" /></Link>
                          </Button>
                          <span className="text-xs text-muted-foreground">
                            {providerConnections.filter((connection) => connection.status === "connected").length} connected account{providerConnections.filter((connection) => connection.status === "connected").length === 1 ? "" : "s"}
                          </span>
                        </div>
                      </div>
                      )}
                      {contextSection === "tools" && (
                      <div className="space-y-3 rounded-xl border bg-muted/10 p-4">
                        <div className="flex items-start gap-3">
                          <Plug className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                          <div>
                            <p className="font-medium">Add remote MCP tools</p>
                            <p className="text-sm text-muted-foreground">
                              Pick a catalog provider such as Notion or GitHub, or configure any compatible MCP endpoint. The MCP editor will guide credential selection and tool discovery.
                            </p>
                          </div>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {SETUP_CONNECTIONS.map((entry) => (
                            <div key={`${entry.provider}-mcp`} className="rounded-lg border p-3">
                              <p className="text-sm font-medium">{entry.label} MCP</p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {entry.provider === "notion" ? "Read and search pages, databases, and blocks." : "Search repositories and inspect pull requests."}
                              </p>
                              <Link
                                className="mt-2 inline-flex items-center text-xs text-primary hover:underline"
                                href="/dynamic-agents?tab=mcp-servers&add=remote"
                                onClick={() => onOpenChange(false)}
                              >
                                Add from catalog<ExternalLink className="ml-1 h-3.5 w-3.5" />
                              </Link>
                            </div>
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          OAuth-capable providers can be connected during MCP setup. Generic dynamic client registration (DCR) still requires provider support and is not assumed for arbitrary endpoints.
                        </p>
                      </div>
                      )}
                      {contextSection === "team" && (
                      <div className="space-y-3 rounded-xl border bg-muted/10 p-4">
                        <div className="flex items-start gap-3">
                          <LayoutGrid className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                          <div>
                            <p className="font-medium">Connect your team workspace</p>
                            <p className="text-sm text-muted-foreground">Optional: let people reach your agent from the tools they already use.</p>
                          </div>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {SETUP_INTEGRATIONS.map((integration) => (
                            <div key={integration.id} className="flex items-start justify-between gap-3 rounded-lg border p-3">
                              <div className="flex min-w-0 gap-2">
                                <Plug className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                                <div className="min-w-0">
                                  <p className="text-sm font-medium">{integration.label}</p>
                                  <p className="text-xs text-muted-foreground">{integration.description}</p>
                                </div>
                              </div>
                              <Button asChild size="sm" variant="outline">
                                <Link href={integration.href} onClick={() => onOpenChange(false)}>Open {integration.label} setup</Link>
                              </Button>
                            </div>
                          ))}
                        </div>
                      </div>
                      )}
                      {contextSection === "knowledge" && <div className="space-y-3">
                      <div className="rounded-xl border bg-muted/10 p-4"><p className="text-sm font-semibold">Give your agent something to learn from</p><p className="mt-1 text-sm text-muted-foreground">Add documents or a website to a knowledge base, then let your agent search it. You control which sources it can access.</p><Button asChild size="sm" variant="outline" className="mt-3"><Link href="/knowledge-bases">Open Knowledge Bases<ChevronRight className="ml-1 h-4 w-4" /></Link></Button></div>
                      <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border p-4">
                        <span className="flex gap-3">
                          <Database className="mt-0.5 h-5 w-5 text-primary" />
                          <span>
                            <span className="block font-medium">Use accessible knowledge bases</span>
                            <span className="block text-sm text-muted-foreground">Your agent can only search sources the person chatting with it is allowed to access.</span>
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          checked={selection.enable_knowledge_base === true}
                          disabled={!mcpServers.some((server) => server._id === "knowledge-base")}
                          onChange={(event) => setSelection((current) => ({ ...current, enable_knowledge_base: event.target.checked }))}
                          className="mt-1 h-4 w-4 accent-primary"
                        />
                      </label>
                      {!mcpServers.some((server) => server._id === "knowledge-base") && <p className="rounded-lg bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">Knowledge search is not available yet. Ask your administrator to deploy RAG and register the knowledge-base MCP server. <a href="https://caipe.io/docs/" target="_blank" rel="noreferrer" className="text-primary hover:underline">Open CAIPE documentation</a>, or continue without knowledge search.</p>}
                      </div>}
                      {contextSection === "tools" && (
                      <div>
                        <p className="mb-2 text-sm font-medium">MCP servers</p>
                        {mcpServers.length === 0 && (
                          <p className="mb-3 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                            No MCP servers are available. <Link className="text-primary hover:underline" href="/dynamic-agents?tab=mcp-servers" onClick={() => onOpenChange(false)}>Configure an MCP server</Link>, or skip this optional step.
                          </p>
                        )}
                        <div className="grid gap-2 sm:grid-cols-2">
                          {mcpServers.filter((server) => server._id !== "knowledge-base").map((server) => {
                            const checked = selection.mcp_server_ids?.includes(server._id) ?? false;
                            return (
                              <label key={server._id} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-muted/40">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(event) => setSelection((current) => ({
                                    ...current,
                                    mcp_server_ids: event.target.checked
                                      ? [...new Set([...(current.mcp_server_ids ?? []), server._id])]
                                      : (current.mcp_server_ids ?? []).filter((id) => id !== server._id),
                                  }))}
                                  className="mt-1 h-4 w-4 accent-primary"
                                />
                                <span>
                                  <span className="block text-sm font-medium">{server.name}</span>
                                  <span className="block text-xs text-muted-foreground">{server.description ?? server._id}</span>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                      )}
                    </div>
                  )}

                  {step === 5 && (
                    <div className="space-y-4">
                      <div className="rounded-xl border bg-muted/20 p-5">
                        <p className="font-semibold">{testResult ? "Your starter configuration" : "Ready for your first conversation?"}</p>
                        {!testResult && <p className="mt-1 text-sm text-muted-foreground">We’ll create a shared starter agent and send “Reply with a brief confirmation that the starter agent is ready.” The response confirms the AI connection works; it does not verify every optional tool. This test may use your provider’s paid quota.</p>}
                        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                          <SummaryItem label="Agent’s job" value={RECIPES.find((recipe) => recipe.id === selection.recipe_id)?.title ?? "SRE starter"} />
                          <SummaryItem label="AI answering your messages" value={selectedModel?.name ?? "Not selected"} />
                          <SummaryItem label="Connected tools" value={String(selection.mcp_server_ids?.length ?? 0)} />
                          <SummaryItem label="Knowledge" value={selection.enable_knowledge_base ? "Enabled" : "Skipped"} />
                        </dl>
                      </div>
                      {testResult ? (
                        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5">
                          <p className="flex items-center gap-2 font-semibold text-emerald-700 dark:text-emerald-300">
                            <CheckCircle2 className="h-5 w-5" /> Your starter agent is working
                          </p>
                          <p className="mt-2 text-sm text-muted-foreground">{testResult}</p>
                          <p className="mt-3 text-sm text-muted-foreground">Basic setup is complete. Come back to Admin → Platform configuration → Setup Wizard to connect accounts, add knowledge, or explore automation.</p>
                          <div className="mt-4 flex flex-wrap gap-2">
                            {testConversationId && (
                              <Button asChild size="sm">
                                <Link href={`/chat/${encodeURIComponent(testConversationId)}`} onClick={() => onOpenChange(false)}>Open test chat</Link>
                              </Button>
                            )}
                            {payload?.state.created_agent_id && (
                              <Button asChild size="sm" variant="outline">
                                <Link href={`/dynamic-agents?tab=agents&agent=${encodeURIComponent(payload.state.created_agent_id)}`} onClick={() => onOpenChange(false)}>
                                  Open starter agent
                                </Link>
                              </Button>
                            )}
                          </div>
                        </div>
                      ) : (
                        <Button onClick={() => void createAndTest()} disabled={runningTest || !selectedModel || requiredHealthFailure} size="lg">
                          {runningTest ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                          {runningTest ? "Waiting for your agent’s reply..." : "Create agent and run test"}
                        </Button>
                      )}
                      {!testResult && !selectedModel && <Button variant="outline" onClick={() => setStep(2)}>Choose a model first</Button>}
                      {requiredHealthFailure && <p role="status" className="text-sm text-amber-600">A required service needs attention. <button type="button" className="underline" onClick={() => setStep(1)}>Review platform checks</button> before testing.</p>}
                      {!testResult && error && <div className="rounded-lg border p-3 text-sm"><p>You can retry after checking your provider access and platform health. Your selections are saved when you minimize.</p><Link className="mt-2 inline-block text-primary hover:underline" href="/dynamic-agents?tab=model-providers">Check provider access</Link></div>}
                    </div>
                  )}
                </>
              )}
            </div>

            <DialogFooter className="flex-row flex-wrap items-center justify-between gap-2 border-t px-6 py-3 sm:justify-between">
              <div className="flex flex-wrap items-center gap-1">
                <Button type="button" variant="ghost" onClick={() => void minimize()} disabled={saving || runningTest || leaving}>
                  <Minimize2 className="mr-2 h-4 w-4" />Save & minimize
                </Button>
                <Button type="button" variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={() => void exitSetup()} disabled={saving || runningTest || leaving}>
                  <X className="mr-2 h-4 w-4" />Exit setup
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {step > 1 && !testResult && (
                  <Button type="button" variant="outline" onClick={() => setStep((current) => current - 1)} disabled={saving || runningTest}>
                    <ChevronLeft className="mr-1 h-4 w-4" /> Back
                  </Button>
                )}
                {step < 5 && (
                  <>
                    {step === 4 && (
                      <Button type="button" variant="outline" onClick={() => void persistProgress(5, 4)} disabled={saving}>
                        Skip this step
                      </Button>
                    )}
                    <Button type="button" onClick={() => void persistProgress(step + 1)} disabled={saving || !canContinue}>
                      {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {step === 1 ? "Let’s get started" : step === 2 ? "Use this AI & continue" : step === 3 ? "Add optional context" : "Review & test"} <ChevronRight className="ml-1 h-4 w-4" />
                    </Button>
                  </>
                )}
                {step === 5 && !testResult && (
                  <Button type="button" variant="outline" onClick={() => void minimize()} disabled={saving || runningTest}>
                    Test later
                  </Button>
                )}
                {step === 5 && testResult && (
                  <Button type="button" onClick={closeCompleted}>Done</Button>
                )}
              </div>
            </DialogFooter>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ModelProviderGuide({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="space-y-3 rounded-xl border bg-muted/10 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">Popular provider options</p>
          <p className="text-xs text-muted-foreground">
            Connect your provider first, then register a model from that provider. Keep credentials in provider configuration.
          </p>
        </div>
        <Button asChild type="button" size="sm" variant="outline">
          <Link href="/dynamic-agents?tab=model-providers" onClick={onNavigate}>
            Configure provider access <ExternalLink className="ml-2 h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {MODEL_PROVIDER_GUIDANCE.map((provider, index) => {
          const Icon = provider.icon;
          return (
            <div
              key={provider.label}
              className="animate-slide-in rounded-lg border p-3"
              style={{ animationDelay: `${index * 70}ms` }}
            >
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-primary" />
                <p className="text-sm font-medium">{provider.label}</p>
              </div>
              <p className="mt-2 text-xs leading-snug text-muted-foreground">{provider.description}</p>
              <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{provider.detail}</p>
              <Link className="mt-2 inline-flex items-center text-[11px] text-primary hover:underline" href="/dynamic-agents?tab=model-providers" onClick={onNavigate}>
                Open provider settings <ChevronRight className="ml-0.5 h-3 w-3" />
              </Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InventoryTile({ label, value, delay = 0 }: { label: string; value: number; delay?: number }) {
  return (
    <div className="animate-fade-in rounded-lg border bg-card p-3 transition-transform duration-300 hover:-translate-y-0.5" style={{ animationDelay: `${delay}ms` }}>
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

export function SetupWizardSettings(): React.ReactElement {
  const [payload, setPayload] = useState<SetupWizardPayload | null>(null);
  const [open, setOpen] = useState(false);
  const [restart, setRestart] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await jsonRequest<ApiEnvelope<SetupWizardPayload>>("/api/admin/setup-wizard");
      setPayload(response.data);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load setup status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-primary" /> Setup Wizard</CardTitle>
            <CardDescription className="mt-1">Review platform readiness and create a first working agent.</CardDescription>
          </div>
          {payload && <Badge variant={payload.state.status === "completed" ? "default" : "secondary"}>{setupStatusLabel(payload.state.status)}</Badge>}
        </CardHeader>
        <CardContent>
          {loading ? <CAIPESpinner message="Loading setup status..." /> : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : payload ? (
            <div className="space-y-5">
              {!payload.enabled && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-300">
                  Automatic setup is disabled by <code>SETUP_WIZARD_ENABLED=false</code>. An administrator can still run the wizard manually here.
                </div>
              )}
              <dl className="grid gap-4 sm:grid-cols-3">
                <SummaryItem label="Status" value={setupStatusLabel(payload.state.status)} />
                <SummaryItem label="Starter agent" value={payload.state.created_agent_id ?? "Not created"} />
                <SummaryItem label="Last completed" value={payload.state.completed_at ? new Date(payload.state.completed_at).toLocaleString() : "Never"} />
              </dl>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => {
                  setRestart(payload.state.status === "completed");
                  setOpen(true);
                }}>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  {payload.state.status === "not_started"
                    ? "Start setup"
                    : payload.state.status === "completed"
                      ? "Run setup again"
                      : "Resume setup"}
                </Button>
                <Button asChild variant="outline"><Link href="/admin/operations/health">View platform health</Link></Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {payload && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Current configuration</CardTitle>
            <CardDescription>Resources discovered by the setup wizard.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <InventoryTile label="Models" value={payload.inventory.models} />
            <InventoryTile label="Agents" value={payload.inventory.agents} />
            <InventoryTile label="MCP servers" value={payload.inventory.mcp_servers} />
            <InventoryTile label="Knowledge sources" value={payload.inventory.knowledge_sources} />
          </CardContent>
        </Card>
      )}

      <SetupWizardDialog
        open={open}
        restart={restart}
        initialPayload={payload}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) void load();
        }}
      />
    </div>
  );
}

export function SetupWizardGate(): React.ReactElement | null {
  const { isAdmin, loading } = useAdminRole();
  const pathname = usePathname();
  const [payload, setPayload] = useState<SetupWizardPayload | null>(null);
  const [open, setOpen] = useState(false);
  const [restart, setRestart] = useState(false);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [resumePulse, setResumePulse] = useState(0);
  const [checklistHidden, setChecklistHidden] = useState(false);
  const [hidingChecklist, setHidingChecklist] = useState(false);
  const [resumeAvailable, setResumeAvailable] = useState(false);

  useEffect(() => {
    const minimized = (event: Event) => {
      setOpen(false);
      setChecklistOpen(false);
      setResumeAvailable(true);
      setChecklistHidden(false);
      const saved = (event as CustomEvent<SetupWizardPayload | null>).detail;
      if (saved) setPayload(saved);
      setResumePulse((current) => current + 1);
      refreshPayload();
      window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>("[data-setup-resume]")?.focus());
    };
    window.addEventListener("caipe:setup-minimized", minimized);
    return () => window.removeEventListener("caipe:setup-minimized", minimized);
  }, []);

  useEffect(() => {
    // A setup handoff should never leave the full-screen dialog over the
    // destination page, including when navigation remounts this gate.
    if (open) setResumePulse((current) => current + 1);
    setOpen(false);
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (loading || !isAdmin || !getConfig("setupWizardEnabled")) return;
    let cancelled = false;
    void jsonRequest<ApiEnvelope<SetupWizardPayload>>("/api/admin/setup-wizard")
      .then((response) => {
        if (cancelled) return;
        setPayload(response.data);
        // First launch should introduce the checklist without blocking the app.
        // The full wizard opens only when the administrator explicitly resumes it.
        setOpen(false);
        setChecklistOpen(false);
      })
      .catch(() => {
        // Non-admins and deployments still starting up should not see a noisy
        // global error. The permanent Admin card exposes actionable failures.
      });
    return () => { cancelled = true; };
  }, [isAdmin, loading]);

  const refreshPayload = () => {
    void jsonRequest<ApiEnvelope<SetupWizardPayload>>("/api/admin/setup-wizard")
      .then((response) => setPayload(response.data))
      .catch(() => undefined);
  };

  const openWizard = (shouldRestart = false) => {
    setRestart(shouldRestart);
    setChecklistOpen(false);
    setOpen(true);
  };

  const restartSetup = async () => {
    try {
      await jsonRequest<ApiEnvelope<{ state: SetupWizardPayload["state"] }>>("/api/admin/setup-wizard", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset" }),
      });
      openWizard(true);
      refreshPayload();
    } catch {
      // The admin settings page remains available if reset fails.
    }
  };

  const hideChecklist = async () => {
    setHidingChecklist(true);
    try {
      await jsonRequest<ApiEnvelope<{ state: SetupWizardPayload["state"] }>>("/api/admin/setup-wizard", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "hide_checklist" }),
      });
      setChecklistHidden(true);
      setChecklistOpen(false);
    } finally {
      setHidingChecklist(false);
    }
  };

  if (!payload || checklistHidden || (!resumeAvailable && (payload.state.checklist_hidden || payload.state.status === "completed"))) return null;

  const checklistItems: Array<{
    label: string;
    detail: string;
    done: boolean;
    optional?: boolean;
    href?: string;
  }> = [
    { label: "Select a model", detail: "Configure access, then choose your model.", done: Boolean(payload.state.selection?.model_id), href: "/dynamic-agents?tab=model-providers" },
    { label: "Choose an agent recipe", detail: "Start with SRE, Hello World, or a blank agent.", done: Boolean(payload.state.selection?.recipe_id) },
    { label: "Run the first test", detail: "Verify the whole path before inviting your team.", done: payload.state.last_smoke_test?.status === "passed" },
    { label: "Add tools or knowledge", detail: "Optional · Connect tools or searchable documents.", optional: true, done: Boolean(payload.state.selection?.mcp_server_ids?.length || payload.state.selection?.enable_knowledge_base), href: "/dynamic-agents?tab=mcp-servers" },
    { label: "Connect credentials", detail: "Optional · Connect the accounts your agent needs.", optional: true, done: payload.inventory.connected_credentials > 0, href: "/credentials/connections" },
  ];
  const basicItems = checklistItems.filter((item) => !item.optional);
  const completedChecklistItems = basicItems.filter((item) => item.done).length;

  return (
    <>
      <div className={cn("fixed bottom-4 right-4 z-[60] max-w-[calc(100vw-2rem)]", open && "invisible pointer-events-none")}>
        {resumePulse > 0 && !checklistOpen && <p role="status" className="mb-2 max-w-64 rounded-xl border bg-card p-3 text-xs text-muted-foreground shadow-lg">Your place is saved. Resume setup here when you’re ready.</p>}
        {checklistOpen && (
          <div className="mb-2 max-h-[min(36rem,calc(100vh-6rem))] w-[min(22rem,calc(100vw-2rem))] animate-slide-in overflow-y-auto rounded-2xl border bg-card/95 p-4 shadow-2xl shadow-primary/10 backdrop-blur-xl [scrollbar-width:thin]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="flex items-center gap-2 text-sm font-semibold"><ListChecks className="h-4 w-4 text-primary" /> Setup checklist</p>
                <p className="mt-1 text-xs text-muted-foreground">One model, one agent, one successful conversation. Extras can wait.</p>
              </div>
              <button type="button" className="text-muted-foreground transition-colors hover:text-foreground" onClick={() => setChecklistOpen(false)} aria-label="Close setup checklist">×</button>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-gradient-to-r from-primary to-violet-500 transition-[width] duration-500" style={{ width: `${(completedChecklistItems / basicItems.length) * 100}%` }} />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">{completedChecklistItems} of {basicItems.length} basic tasks ready · Extras are optional</p>
            <ul className="mt-3 space-y-2">
              {checklistItems.map((item) => {
                const content = (
                  <>
                    <span className={cn("mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border", item.done ? "border-emerald-500 bg-emerald-500 text-white" : "border-muted-foreground/40 text-transparent")}>
                      <Check className="h-3 w-3" />
                    </span>
                    <span className="min-w-0 text-left"><span className={cn("font-medium", item.done && "text-muted-foreground")}>{item.label}</span><span className="block text-[11px] text-muted-foreground">{item.detail}</span></span>
                    {!item.done && item.href && <ChevronRight className="ml-auto mt-1 h-3.5 w-3.5 shrink-0 text-primary" />}
                  </>
                );
                return (
                  <li key={item.label} className="text-xs">
                    {item.href ? (
                      <Link className="flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50" href={item.href} onClick={() => { setChecklistOpen(false); setOpen(false); }}>
                        {content}
                      </Link>
                    ) : (
                      <button type="button" className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/50" onClick={() => openWizard(false)}>
                        {content}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="mt-4 grid gap-2">
              <Button size="sm" onClick={() => openWizard(false)}>
                {payload.state.status === "dismissed" ? "Continue setup" : "Resume setup"}<ChevronRight className="ml-1 h-3.5 w-3.5" />
              </Button>
              <div className="grid gap-2">
                <Button size="sm" variant="outline" className="w-full justify-center" onClick={() => void restartSetup()}>
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Restart platform setup
                </Button>
                <Button size="sm" variant="ghost" className="w-full justify-center" onClick={() => void hideChecklist()} disabled={hidingChecklist}>Don’t show again</Button>
              </div>
            </div>
            <div className="mt-3 flex gap-3 border-t pt-3 text-[11px]">
              <Link className="text-primary hover:underline" href="/admin/integrations/slack" onClick={() => { setChecklistOpen(false); setOpen(false); }}>Connect Slack</Link>
              <Link className="text-primary hover:underline" href="/admin/integrations/webex" onClick={() => { setChecklistOpen(false); setOpen(false); }}>Connect Webex</Link>
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2">
        <Button
          key={resumePulse}
          type="button"
          size="sm"
          variant="outline"
          className={cn(
            "ml-auto flex max-w-full items-center gap-2 rounded-full bg-card/90 shadow-lg backdrop-blur-xl",
            resumePulse > 0 && "animate-setup-bubble-in",
          )}
          onClick={() => openWizard(false)}
          data-setup-resume
          aria-label="Resume setup"
        >
          <ListChecks className="h-4 w-4 text-primary" />
          Resume setup
        </Button>
        <Button size="sm" variant="outline" className="rounded-full bg-card/90 shadow-lg" aria-label="Open setup checklist" aria-expanded={checklistOpen} onClick={() => setChecklistOpen((current) => !current)}><ListChecks className="mr-1 h-4 w-4 text-primary" />{completedChecklistItems}/{basicItems.length}</Button>
        </div>
      </div>
      <SetupWizardDialog
        open={open}
        restart={restart}
        initialPayload={payload}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && open) setResumePulse((current) => current + 1);
          setOpen(nextOpen);
          if (!nextOpen) refreshPayload();
        }}
        onStateChange={(nextPayload) => {
          if (!nextPayload) setResumeAvailable(false);
          refreshPayload();
        }}
      />
    </>
  );
}
