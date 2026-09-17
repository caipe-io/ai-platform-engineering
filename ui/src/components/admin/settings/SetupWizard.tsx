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
  Circle,
  Database,
  ExternalLink,
  Gauge,
  Loader2,
  LayoutGrid,
  Play,
  RotateCcw,
  Sparkles,
  TriangleAlert,
  XCircle,
  Workflow,
} from "lucide-react";
import Link from "next/link";
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

interface HealthCapability {
  id: string;
  label: string;
  status: "healthy" | "degraded" | "down" | "disabled";
  detail: string;
  required: boolean;
}

interface Remediation {
  href: string;
  label: string;
  description: string;
}

interface HealthPayload {
  status: "healthy" | "degraded" | "down";
  capabilities: HealthCapability[];
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
  { id: 1, label: "Readiness", icon: Gauge },
  { id: 2, label: "Model", icon: Sparkles },
  { id: 3, label: "Agent", icon: Bot },
  { id: 4, label: "Knowledge & tools", icon: Database },
  { id: 5, label: "Test", icon: Play },
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

const APPLY_ALL_MIGRATIONS_CONFIRMATION = "APPLY ALL PENDING MIGRATIONS";

type SetupFeatureKey = "workflows" | "schedules" | "autonomous_agents" | "apps";

const SETUP_FEATURES: Array<{
  key: SetupFeatureKey;
  label: string;
  description: string;
  deployment: string;
  href: string;
  icon: typeof Workflow;
}> = [
  {
    key: "workflows",
    label: "Workflows",
    description: "Run multi-step agent workflows from the Workflows workspace.",
    deployment: "Requires WORKFLOWS_ENABLED and WORKFLOW_RUNNER_ENABLED.",
    href: "/workflows",
    icon: Workflow,
  },
  {
    key: "schedules",
    label: "Schedules",
    description: "Run an agent on a recurring schedule or trigger.",
    deployment: "Requires the Scheduler deployment and SCHEDULER_ENABLED.",
    href: "/schedules",
    icon: CalendarClock,
  },
  {
    key: "autonomous_agents",
    label: "Autonomous Agents",
    description: "Let agents run on cron, interval, and webhook triggers.",
    deployment: "Requires the autonomous-agents service and ENABLE_AUTONOMOUS_AGENTS.",
    href: "/autonomous",
    icon: Sparkles,
  },
  {
    key: "apps",
    label: "Apps",
    description: "Expose the deployment-owned External Apps catalog.",
    deployment: "Requires AGENTIC_APPS_INSTALL_ENABLED and an app catalog.",
    href: "/apps",
    icon: LayoutGrid,
  },
];

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
  if (!response.ok) throw new Error(messageFromPayload(payload, `Request failed (${response.status})`));
  return payload as T;
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
  const [payload, setPayload] = useState<SetupWizardPayload | null>(initialPayload ?? null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [mcpServers, setMcpServers] = useState<MCPOption[]>([]);
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
  const [confirmMigrationRemediation, setConfirmMigrationRemediation] = useState(false);
  const [remediatingMigrations, setRemediatingMigrations] = useState(false);
  const [migrationRemediationResult, setMigrationRemediationResult] = useState<string | null>(null);

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
      const [setupResponse, healthResponse, modelResponse, mcpResponse] = await Promise.all([
        jsonRequest<ApiEnvelope<SetupWizardPayload>>("/api/admin/setup-wizard"),
        healthRequest(),
        jsonRequest<ApiEnvelope<ListEnvelope<ModelOption>>>("/api/llm-models?page_size=100"),
        jsonRequest<ApiEnvelope<ListEnvelope<MCPOption>>>("/api/mcp-servers?page_size=100"),
      ]);
      const nextPayload = setupResponse.data;
      const nextModels = modelResponse.data.items ?? [];
      const nextMcpServers = (mcpResponse.data.items ?? []).filter((server) => server.enabled !== false);
      setPayload(nextPayload);
      setHealth(healthResponse);
      setModels(nextModels);
      setMcpServers(nextMcpServers);
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

  const persistProgress = async (nextStep: number, skippedStep?: number) => {
    setSaving(true);
    setError(null);
    try {
      const completed = [...new Set([...(payload?.state.completed_steps ?? []), step])];
      const skipped = skippedStep
        ? [...new Set([...(payload?.state.skipped_steps ?? []), skippedStep])]
        : payload?.state.skipped_steps ?? [];
      await patchState({
        action: "progress",
        current_step: nextStep,
        completed_steps: completed,
        skipped_steps: skipped,
        selection,
      });
      window.dispatchEvent(new Event("caipe:platform-features-updated"));
      setStep(nextStep);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save setup progress");
    } finally {
      setSaving(false);
    }
  };

  const dismiss = async () => {
    setSaving(true);
    try {
      await patchState({ action: "dismiss", current_step: step, selection });
      onOpenChange(false);
      onStateChange?.(null);
    } catch (dismissError) {
      setError(dismissError instanceof Error ? dismissError.message : "Could not dismiss setup");
    } finally {
      setSaving(false);
    }
  };

  const finishWithoutTest = async () => {
    setSaving(true);
    setError(null);
    try {
      await patchState({
        action: "complete",
        current_step: 5,
        completed_steps: payload?.state.completed_steps ?? [],
        skipped_steps: [...new Set([...(payload?.state.skipped_steps ?? []), 5])],
        selection,
      });
      onOpenChange(false);
      onStateChange?.(null);
      requestProductTour();
    } catch (finishError) {
      setError(finishError instanceof Error ? finishError.message : "Could not finish setup");
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

  const autoRemediateMigrations = async () => {
    setError(null);
    setMigrationRemediationResult(null);
    setRemediatingMigrations(true);
    try {
      const result = await jsonRequest<ApiEnvelope<{
        applied_count: number;
        failed_count: number;
        skipped_count: number;
      }>>("/api/admin/rebac/migrations/apply-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: APPLY_ALL_MIGRATIONS_CONFIRMATION }),
      });
      const summary = result.data;
      setMigrationRemediationResult(
        `${summary.applied_count} migration${summary.applied_count === 1 ? "" : "s"} applied` +
          (summary.failed_count > 0 ? `; ${summary.failed_count} failed` : "") +
          (summary.skipped_count > 0 ? `; ${summary.skipped_count} skipped` : ""),
      );
      setConfirmMigrationRemediation(false);
      setHealth(await healthRequest());
    } catch (remediationError) {
      setError(remediationError instanceof Error ? remediationError.message : "Could not apply RBAC migrations");
    } finally {
      setRemediatingMigrations(false);
    }
  };

  const canContinue = step !== 2 || Boolean(selectedModel);

  const closeCompleted = () => {
    onOpenChange(false);
    onStateChange?.(null);
    requestProductTour();
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen && !saving && !runningTest) {
        if (payload?.state.status === "completed") closeCompleted();
        else void dismiss();
      }
    }}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-hidden p-0">
        <div className="grid min-h-[650px] grid-cols-1 md:grid-cols-[220px_1fr]">
          <aside className="border-b bg-muted/25 p-5 md:border-b-0 md:border-r">
            <div className="mb-6 flex items-center gap-2">
              <span className="rounded-lg bg-primary/10 p-2 text-primary"><Sparkles className="h-5 w-5" /></span>
              <div>
                <p className="font-semibold">Platform setup</p>
                <p className="text-xs text-muted-foreground">First working agent</p>
              </div>
            </div>
            <ol className="grid grid-cols-5 gap-2 md:grid-cols-1">
              {STEPS.map((item) => {
                const Icon = item.icon;
                const complete = (payload?.state.completed_steps ?? []).includes(item.id) || item.id < step;
                const active = item.id === step;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors md:text-sm",
                        active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted",
                      )}
                      onClick={() => setStep(item.id)}
                    >
                      <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full border", complete && "border-primary bg-primary text-primary-foreground", active && !complete && "border-primary")}>
                        {complete ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
                      </span>
                      <span className="hidden md:inline">{item.label}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </aside>

          <section className="flex min-h-0 flex-col">
            <DialogHeader className="border-b px-6 py-5 text-left">
              <DialogTitle>{STEPS[step - 1].label}</DialogTitle>
              <DialogDescription>
                {step === 1 && "Check the services needed for a working agent."}
                {step === 2 && "Choose the model your starter agent will use."}
                {step === 3 && "Start with a useful recipe or a minimal agent."}
                {step === 4 && "Attach optional knowledge and MCP tools."}
                {step === 5 && "Create the agent and verify an end-to-end response."}
              </DialogDescription>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {loading ? (
                <div className="grid min-h-72 place-items-center"><CAIPESpinner message="Inspecting this deployment..." /></div>
              ) : (
                <>
                  {error && (
                    <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{error}</span>
                    </div>
                  )}

                  {step === 1 && (
                    <div className="space-y-4">
                      <div className="grid gap-3 sm:grid-cols-3">
                        <InventoryTile label="Models" value={payload?.inventory.models ?? 0} />
                        <InventoryTile label="MCP servers" value={payload?.inventory.mcp_servers ?? 0} />
                        <InventoryTile label="Knowledge sources" value={payload?.inventory.knowledge_sources ?? 0} />
                      </div>
                      <div className="space-y-2">
                        {(health?.capabilities ?? []).filter((capability) =>
                          ["chat-runtime", "dynamic-agents", "knowledge-bases", "authentication"].includes(capability.id)
                        ).map((capability) => (
                          <CapabilityRow
                            key={capability.id}
                            capability={capability}
                            remediation={getCapabilityRemediation(capability, health?.probes)}
                          />
                        ))}
                        {health?.probes?.filter((probe) => probe.id === "rebac-migrations").map((probe) => (
                          <div key={probe.id} className="flex items-start justify-between gap-4 rounded-lg border p-3">
                            <div className="flex gap-3">
                              {probe.status === "healthy"
                                ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-500" />
                                : <TriangleAlert className="mt-0.5 h-5 w-5 text-amber-500" />}
                              <div>
                                <p className="text-sm font-medium">{probe.label}</p>
                                <p className="text-xs text-muted-foreground">{probe.detail}</p>
                                {probe.status !== "healthy" && (
                                  <div className="mt-2 space-y-2">
                                    <p className="text-xs text-muted-foreground">
                                      Review the pending changes before applying them. The operation is idempotent and runs in dependency order.
                                    </p>
                                    <div className="flex flex-wrap items-center gap-2">
                                      {probe.remediation && (
                                        <Link className="text-xs text-primary hover:underline" href={probe.remediation.href}>
                                          {probe.remediation.label}
                                        </Link>
                                      )}
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setConfirmMigrationRemediation(true)}
                                        disabled={remediatingMigrations}
                                      >
                                        {remediatingMigrations && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                                        Auto-remediate
                                      </Button>
                                    </div>
                                    {confirmMigrationRemediation && (
                                      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                                        <p className="text-xs text-amber-700 dark:text-amber-300">
                                          This applies all pending RBAC migrations and changes live access data. Continue only if this deployment is ready for the migration.
                                        </p>
                                        <div className="mt-2 flex gap-2">
                                          <Button type="button" size="sm" variant="outline" onClick={() => setConfirmMigrationRemediation(false)} disabled={remediatingMigrations}>
                                            Cancel
                                          </Button>
                                          <Button type="button" size="sm" onClick={() => void autoRemediateMigrations()} disabled={remediatingMigrations}>
                                            Confirm and apply
                                          </Button>
                                        </div>
                                      </div>
                                    )}
                                    {migrationRemediationResult && (
                                      <p className="text-xs text-emerald-700 dark:text-emerald-300">{migrationRemediationResult}</p>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                            <Badge variant="outline">{probe.status}</Badge>
                          </div>
                        ))}
                        {!health && (
                          <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-300">
                            Health details are unavailable. You can continue and validate with the smoke test.
                          </p>
                        )}
                      </div>
                      <div className="space-y-3 rounded-xl border bg-muted/10 p-4">
                        <div>
                          <p className="font-medium">Enable platform capabilities</p>
                          <p className="text-sm text-muted-foreground">
                            Choose which deployed surfaces should appear in the application navigation. Deployment flags remain the hard service gate.
                          </p>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {SETUP_FEATURES.map((feature) => {
                            const Icon = feature.icon;
                            const deployed = deploymentFeatureDefaults()[feature.key];
                            const enabled = selection.enabled_features?.[feature.key] ?? deployed;
                            return (
                              <label
                                key={feature.key}
                                className={cn(
                                  "flex items-start gap-3 rounded-lg border p-3",
                                  deployed ? "cursor-pointer hover:bg-muted/40" : "cursor-not-allowed opacity-70",
                                )}
                              >
                                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-center justify-between gap-2">
                                    <span className="text-sm font-medium">{feature.label}</span>
                                    <input
                                      type="checkbox"
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
                                  <span className="mt-1 block text-xs text-muted-foreground">{feature.description}</span>
                                  <span className="mt-2 block text-[11px] text-muted-foreground">
                                    {deployed ? "Available in this deployment." : feature.deployment}
                                  </span>
                                  {deployed && (
                                    <Link className="mt-1 inline-block text-xs text-primary hover:underline" href={feature.href}>
                                      Open {feature.label}
                                    </Link>
                                  )}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Workflows include a short guided explanation in the Workflows workspace. Apps require a deployment-owned catalog before they can be enabled.
                        </p>
                      </div>
                      {requiredHealthFailure && (
                        <p className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
                          <TriangleAlert className="h-4 w-4" /> A required service is down. Fix it before the final smoke test.
                        </p>
                      )}
                    </div>
                  )}

                  {step === 2 && (
                    <div className="space-y-3">
                      {models.length === 0 ? (
                        <div className="space-y-4 rounded-xl border border-dashed p-6">
                          <div className="text-center">
                            <Sparkles className="mx-auto h-8 w-8 text-muted-foreground" />
                            <p className="mt-3 font-semibold">No models are configured</p>
                            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Add a model here to continue setting up your first working agent.</p>
                          </div>
                          {showAddModel ? (
                            <div className="mx-auto max-w-md space-y-3">
                              <div><Label htmlFor="setup-model-id">Model ID</Label><Input id="setup-model-id" placeholder="claude-haiku-4-5" value={newModel.model_id} onChange={(e) => setNewModel({ ...newModel, model_id: e.target.value })} /></div>
                              <div><Label htmlFor="setup-model-name">Display name</Label><Input id="setup-model-name" placeholder="Claude Haiku" value={newModel.name} onChange={(e) => setNewModel({ ...newModel, name: e.target.value })} /></div>
                              <div><Label htmlFor="setup-model-provider">Provider</Label><Input id="setup-model-provider" placeholder="openai or anthropic" value={newModel.provider} onChange={(e) => setNewModel({ ...newModel, provider: e.target.value })} /></div>
                              <div className="flex gap-2"><Button onClick={() => void addModel()} disabled={saving || !newModel.model_id || !newModel.name || !newModel.provider}>{saving ? "Adding..." : "Add model"}</Button><Button variant="outline" onClick={() => setShowAddModel(false)}>Cancel</Button></div>
                            </div>
                          ) : <div className="flex justify-center gap-2"><Button onClick={() => setShowAddModel(true)}><Sparkles className="mr-2 h-4 w-4" />Add a model</Button><Button asChild variant="outline"><Link href="/dynamic-agents?tab=llm-models">Advanced configuration<ExternalLink className="ml-2 h-4 w-4" /></Link></Button></div>}
                        </div>
                      ) : models.map((model) => (
                        <button
                          key={model._id}
                          type="button"
                          onClick={() => setSelection((current) => ({
                            ...current,
                            model_id: model._id,
                            model_provider: model.provider,
                          }))}
                          className={cn(
                            "flex w-full items-center justify-between rounded-lg border p-4 text-left transition-colors",
                            selection.model_id === model._id ? "border-primary bg-primary/5" : "hover:bg-muted/40",
                          )}
                        >
                          <span>
                            <span className="block font-medium">{model.name}</span>
                            <span className="block text-xs text-muted-foreground">{model.provider} · {model._id}</span>
                          </span>
                          {selection.model_id === model._id ? <CheckCircle2 className="h-5 w-5 text-primary" /> : <Circle className="h-5 w-5 text-muted-foreground/50" />}
                        </button>
                      ))}
                    </div>
                  )}

                  {step === 3 && (
                    <div className="grid gap-3 lg:grid-cols-3">
                      {RECIPES.map((recipe) => (
                        <button
                          key={recipe.id}
                          type="button"
                          onClick={() => setSelection((current) => ({ ...current, recipe_id: recipe.id }))}
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
                  )}

                  {step === 4 && (
                    <div className="space-y-4">
                      <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border p-4">
                        <span className="flex gap-3">
                          <Database className="mt-0.5 h-5 w-5 text-primary" />
                          <span>
                            <span className="block font-medium">Use accessible knowledge bases</span>
                            <span className="block text-sm text-muted-foreground">The runtime still enforces each caller&apos;s RAG permissions.</span>
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
                      <div>
                        <p className="mb-2 text-sm font-medium">MCP servers</p>
                        {mcpServers.length === 0 && (
                          <p className="mb-3 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                            No MCP servers are available. <Link className="text-primary hover:underline" href="/dynamic-agents?tab=mcp-servers">Configure an MCP server</Link>, or skip this optional step.
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
                    </div>
                  )}

                  {step === 5 && (
                    <div className="space-y-4">
                      <div className="rounded-xl border bg-muted/20 p-5">
                        <p className="font-semibold">Ready to create your starter agent</p>
                        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                          <SummaryItem label="Recipe" value={RECIPES.find((recipe) => recipe.id === selection.recipe_id)?.title ?? "SRE starter"} />
                          <SummaryItem label="Model" value={selectedModel?.name ?? "Not selected"} />
                          <SummaryItem label="MCP servers" value={String(selection.mcp_server_ids?.length ?? 0)} />
                          <SummaryItem label="Knowledge" value={selection.enable_knowledge_base ? "Enabled" : "Skipped"} />
                        </dl>
                      </div>
                      {testResult ? (
                        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5">
                          <p className="flex items-center gap-2 font-semibold text-emerald-700 dark:text-emerald-300">
                            <CheckCircle2 className="h-5 w-5" /> Your starter agent is working
                          </p>
                          <p className="mt-2 text-sm text-muted-foreground">{testResult}</p>
                          <div className="mt-4 flex flex-wrap gap-2">
                            {testConversationId && (
                              <Button asChild size="sm">
                                <Link href={`/chat/${encodeURIComponent(testConversationId)}`}>Open test chat</Link>
                              </Button>
                            )}
                            {payload?.state.created_agent_id && (
                              <Button asChild size="sm" variant="outline">
                                <Link href={`/dynamic-agents?tab=agents&agent=${encodeURIComponent(payload.state.created_agent_id)}`}>
                                  Open starter agent
                                </Link>
                              </Button>
                            )}
                          </div>
                        </div>
                      ) : (
                        <Button onClick={() => void createAndTest()} disabled={runningTest || !selectedModel} size="lg">
                          {runningTest ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                          {runningTest ? "Running end-to-end test..." : "Create agent and run test"}
                        </Button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <DialogFooter className="flex-row items-center justify-between border-t px-6 py-4 sm:justify-between">
              <Button type="button" variant="ghost" onClick={() => void dismiss()} disabled={saving || runningTest}>
                Skip for now
              </Button>
              <div className="flex items-center gap-2">
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
                      Continue <ChevronRight className="ml-1 h-4 w-4" />
                    </Button>
                  </>
                )}
                {step === 5 && !testResult && (
                  <Button type="button" variant="outline" onClick={() => void finishWithoutTest()} disabled={saving || runningTest}>
                    Finish without test
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

function InventoryTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function getCapabilityRemediation(
  capability: HealthCapability,
  probes: HealthPayload["probes"],
): Remediation | undefined {
  if (capability.id === "knowledge-bases") {
    const ragProbe = probes?.find((probe) => probe.id === "rag-server");
    return {
      href: ragProbe?.remediation?.href ?? "/knowledge-bases",
      label: ragProbe?.remediation?.label ?? "Open Knowledge Bases",
      description: ragProbe?.detail ?? "Check the RAG server dependencies and enable the RAG service/profile if it is not running.",
    };
  }
  return undefined;
}

function CapabilityRow({ capability, remediation }: { capability: HealthCapability; remediation?: Remediation }) {
  const healthy = capability.status === "healthy";
  const disabled = capability.status === "disabled";
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
      <div className="flex gap-3">
        {healthy ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-500" /> : disabled ? <Circle className="mt-0.5 h-5 w-5 text-muted-foreground" /> : <TriangleAlert className="mt-0.5 h-5 w-5 text-amber-500" />}
        <div>
          <p className="text-sm font-medium">{capability.label}</p>
          <p className="text-xs text-muted-foreground">{capability.detail}</p>
          {remediation && !healthy && (
            <div className="mt-2 space-y-1">
              <p className="text-xs text-muted-foreground"><span className="font-medium">How to fix:</span> {remediation.description}</p>
              <Link className="text-xs text-primary hover:underline" href={remediation.href}>{remediation.label}</Link>
            </div>
          )}
        </div>
      </div>
      <Badge variant="outline">{capability.status}</Badge>
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
  const [payload, setPayload] = useState<SetupWizardPayload | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (loading || !isAdmin || !getConfig("setupWizardEnabled")) return;
    let cancelled = false;
    void jsonRequest<ApiEnvelope<SetupWizardPayload>>("/api/admin/setup-wizard")
      .then((response) => {
        if (cancelled) return;
        setPayload(response.data);
        setOpen(response.data.auto_start);
      })
      .catch(() => {
        // Non-admins and deployments still starting up should not see a noisy
        // global error. The permanent Admin card exposes actionable failures.
      });
    return () => { cancelled = true; };
  }, [isAdmin, loading]);

  if (!payload) return null;
  return (
    <SetupWizardDialog
      open={open}
      initialPayload={payload}
      onOpenChange={setOpen}
      onStateChange={() => setPayload(null)}
    />
  );
}
