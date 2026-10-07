"use client";

import { cn } from "@/lib/utils";
import { CheckCircle2,Clock,ExternalLink,Loader2,PauseCircle,Workflow,XCircle } from "lucide-react";
import { useCallback,useEffect,useState } from "react";
import { MetadataInputForm,type InputField } from "@/components/chat/MetadataInputForm";
import { pushWithNavigationProgress } from "@/lib/navigation-progress";
import { useRouter } from "next/navigation";

interface WorkflowRunInfo {
  runId: string;
  workflowConfigId?: string;
}

interface StepInterrupt {
  type: "input_required" | "tool_approval";
  interruptId?: string;
  prompt?: string;
  fields?: unknown[];
  agent?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}

interface RunStatus {
  _id: string;
  workflow_config_id: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "waiting_for_input";
  started_at?: string;
  completed_at?: string;
  current_step_index?: number;
  steps?: Array<{
    status?: string;
    display_text?: string;
    response?: string;
    interrupt?: StepInterrupt | null;
  }>;
}

function summarizeStepOutputs(steps: RunStatus["steps"]): string | null {
  if (!steps?.length) return null;
  const parts: string[] = [];
  for (const step of steps) {
    if (step.status === "completed" && step.response?.trim()) {
      const label = step.display_text?.trim();
      parts.push(label ? `${label}: ${step.response.trim()}` : step.response.trim());
    }
  }
  if (parts.length === 0) return null;
  const joined = parts.join("\n\n");
  return joined.length > 500 ? `${joined.slice(0, 497)}...` : joined;
}

function completedStepCount(steps: RunStatus["steps"]): number {
  if (!steps?.length) return 0;
  return steps.filter((step) => step.status === "completed").length;
}

interface WorkflowConfigInfo {
  name: string;
  description?: string;
}

interface WorkflowRunCardProps {
  runs: WorkflowRunInfo[];
}

const STATUS_CONFIG = {
  pending: { icon: Clock, label: "Pending", className: "text-sky-400", bg: "border-sky-500/30 bg-sky-500/5" },
  running: { icon: Loader2, label: "Running", className: "text-sky-400 animate-spin", bg: "border-sky-500/30 bg-sky-500/5" },
  waiting_for_input: { icon: PauseCircle, label: "Input required", className: "text-amber-400", bg: "border-amber-500/30 bg-amber-500/5" },
  completed: { icon: CheckCircle2, label: "Completed", className: "text-emerald-400", bg: "border-emerald-500/30 bg-emerald-500/5" },
  failed: { icon: XCircle, label: "Failed", className: "text-red-400", bg: "border-red-500/30 bg-red-500/5" },
  cancelled: { icon: XCircle, label: "Cancelled", className: "text-muted-foreground", bg: "border-border bg-muted/30" },
} as const;

const TERMINAL_STATUSES = new Set<RunStatus["status"]>(["completed", "failed", "cancelled"]);
const RUNNING_POLL_INTERVAL_MS = 2000;
const IDLE_POLL_INTERVAL_MS = 10000;

function RunCard({ runId }: { runId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [configInfo, setConfigInfo] = useState<WorkflowConfigInfo | null>(null);
  const [hidden, setHidden] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/workflow-runs?run_id=${encodeURIComponent(runId)}`, {
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 404) {
        setHidden(true);
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      setStatus(data);
    } catch {
      // silently ignore transient errors
    }
  }, [runId]);

  useEffect(() => {
    if (!status?.workflow_config_id || configInfo) return;
    (async () => {
      try {
        const res = await fetch(`/api/workflow-configs?id=${encodeURIComponent(status.workflow_config_id)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data?.name) setConfigInfo({ name: data.name, description: data.description });
      } catch { /* best-effort */ }
    })();
  }, [status?.workflow_config_id, configInfo]);

  useEffect(() => {

    void fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (hidden || (status && TERMINAL_STATUSES.has(status.status))) return;
    const interval = setInterval(
      fetchStatus,
      status?.status === "running" ? RUNNING_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS,
    );
    return () => clearInterval(interval);
  }, [status, hidden, fetchStatus]);

  const handleResume = useCallback(async (resumeData: string) => {
    const waitingStepIndex = status?.steps?.findIndex((s) => s.status === "waiting_for_input") ?? -1;
    if (waitingStepIndex < 0) return;
    setIsSubmitting(true);
    try {
      await fetch(`/api/workflow-runs/${encodeURIComponent(runId)}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step_index: waitingStepIndex, resume_data: resumeData }),
      });
      await fetchStatus();
    } finally {
      setIsSubmitting(false);
    }
  }, [runId, status, fetchStatus]);

  if (hidden) return null;

  const cfg = status ? STATUS_CONFIG[status.status] || STATUS_CONFIG.running : null;
  const StatusIcon = cfg?.icon || Clock;
  const isWaitingForInput = status?.status === "waiting_for_input";
  const waitingStepIndex = status?.steps?.findIndex((s) => s.status === "waiting_for_input") ?? -1;
  const waitingStep = waitingStepIndex >= 0 ? status?.steps?.[waitingStepIndex] : null;
  const interrupt = waitingStep?.interrupt ?? null;

  const outputSummary =
    status && (status.status === "completed" || status.status === "failed")
      ? summarizeStepOutputs(status.steps)
      : null;
  const stepProgress =
    status?.steps && status.steps.length > 0
      ? `${completedStepCount(status.steps)}/${status.steps.length} steps`
      : null;

  // When waiting for input with interrupt data: render the form as primary UI (matches agent HITL style)
  if (isWaitingForInput && interrupt) {
    const workflowLabel = configInfo?.name
      ? `Workflow: ${configInfo.name}${stepProgress ? ` · ${stepProgress}` : ""}`
      : stepProgress
        ? `Workflow · ${stepProgress}`
        : "Workflow";
    const interruptDescription = interrupt.agent
      ? `Requested by ${interrupt.agent} · ${workflowLabel}`
      : workflowLabel;

    if (interrupt.type === "input_required") {
      const fields = (interrupt.fields || []) as InputField[];
      const effectiveFields: InputField[] = fields.length > 0
        ? fields
        : [{ field_name: "response", field_label: "Your response", field_type: "text", required: true }];

      return (
        <MetadataInputForm
          messageId={`wf-card-${runId}-step-${waitingStepIndex}`}
          title={interrupt.prompt || "Input Required"}
          description={interruptDescription}
          inputFields={effectiveFields}
          onSubmit={(formData) => handleResume(JSON.stringify({ type: "form_input", values: formData }))}
          onCancel={() => pushWithNavigationProgress(router,`/workflows/run/${runId}`)}
          disabled={isSubmitting}
        />
      );
    }

    // tool_approval interrupt
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-amber-500">Tool Approval Required</p>
            <p className="text-xs text-muted-foreground mt-0.5">{interruptDescription}</p>
            {interrupt.prompt && (
              <p className="text-xs text-foreground/80 mt-1">{interrupt.prompt}</p>
            )}
          </div>
          <button
            onClick={() => pushWithNavigationProgress(router,`/workflows/run/${runId}`)}
            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            title="Open workflow run"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </div>
        {interrupt.toolName && (
          <div className="rounded-md bg-muted/60 px-3 py-2 text-xs font-mono">
            <span className="text-foreground/80">{interrupt.toolName}</span>
            {interrupt.toolArgs && Object.keys(interrupt.toolArgs).length > 0 && (
              <pre className="mt-1 text-[10px] text-muted-foreground whitespace-pre-wrap break-all">
                {JSON.stringify(interrupt.toolArgs, null, 2)}
              </pre>
            )}
          </div>
        )}
        <div className="flex gap-2">
          <button
            disabled={isSubmitting}
            onClick={() => handleResume(JSON.stringify({ type: "tool_approval", decision: "approve" }))}
            className="flex-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
          >
            Approve
          </button>
          <button
            disabled={isSubmitting}
            onClick={() => handleResume(JSON.stringify({ type: "tool_approval", decision: "reject" }))}
            className="flex-1 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            Reject
          </button>
        </div>
      </div>
    );
  }

  // Waiting but interrupt data not yet loaded: show a clear CTA
  if (isWaitingForInput) {
    return (
      <div
        className={cn("rounded-lg border p-3 space-y-2", cfg?.bg || "border-border bg-card/50")}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
            <Workflow className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{configInfo?.name || "Workflow Run"}</span>
              <PauseCircle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
              <span className="text-xs font-medium text-amber-500">Input required</span>
            </div>
            {stepProgress && <span className="text-[10px] text-muted-foreground">{stepProgress}</span>}
          </div>
          <button
            onClick={() => pushWithNavigationProgress(router,`/workflows/run/${runId}`)}
            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </div>
        <button
          onClick={() => pushWithNavigationProgress(router,`/workflows/run/${runId}`)}
          className="w-full text-left text-xs font-medium text-amber-500 hover:text-amber-400 transition-colors"
        >
          Respond to workflow →
        </button>
      </div>
    );
  }

  // Normal (running / completed / failed / cancelled) card
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border p-3 transition-colors cursor-pointer hover:bg-muted/50",
        cfg?.bg || "border-border bg-card/50"
      )}
      onClick={() => pushWithNavigationProgress(router,`/workflows/run/${runId}`)}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
        <Workflow className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">
            {configInfo?.name || "Workflow Run"}
          </span>
          <StatusIcon className={cn("h-3.5 w-3.5 shrink-0", cfg?.className || "text-muted-foreground")} />
          <span className="text-[10px] text-muted-foreground">{cfg?.label || "Loading..."}</span>
        </div>
        {configInfo?.description && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{configInfo.description}</p>
        )}
        <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
          {status?.started_at && (
            <span>{new Date(status.started_at).toLocaleString()}</span>
          )}
          {stepProgress && <span>{stepProgress}</span>}
        </div>
        {outputSummary && (
          <p className="text-xs text-foreground/90 mt-1.5 line-clamp-4 whitespace-pre-wrap">
            {outputSummary}
          </p>
        )}
      </div>
      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </div>
  );
}

/**
 * Renders workflow run cards as a sidecar section in the chat timeline.
 * Each card polls for status updates until the run reaches a terminal state.
 * When a run is waiting_for_input with an interrupt, the form renders
 * inline matching the agent HITL style — no page navigation required.
 */
export function WorkflowRunCard({ runs }: WorkflowRunCardProps) {
  if (runs.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium">
        <Workflow className="h-3.5 w-3.5" />
        <span>Workflow{runs.length > 1 ? "s" : ""}</span>
      </div>
      <div className="space-y-2">
        {runs.map((run) => (
          <RunCard key={run.runId} runId={run.runId} />
        ))}
      </div>
    </div>
  );
}
