import type { StreamEvent } from "@/lib/streaming/types";
import { create } from "zustand";

/**
 * Workflow Execution Store (v2)
 *
 * Manages workflow run state for the Workflows execution view.
 * Communicates with /api/workflow-runs (new engine-backed routes).
 *
 * Events are stored per-step (Map<number, StreamEvent[]>) instead of a flat array.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readWorkflowApiError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const json = JSON.parse(text) as { error?: string; message?: string };
    if (typeof json.error === "string" && json.error.trim()) return json.error;
    if (typeof json.message === "string" && json.message.trim()) return json.message;
  } catch {
    // fall through
  }
  return text.trim() || `Request failed (${res.status})`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WfRunStatus =
  | "pending"
  | "running"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "cancelled";

export type WfStepStatus =
  | "pending"
  | "running"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "skipped";

export interface WfStepRun {
  type: "step";
  index: number;
  display_text: string;
  agent_id: string;
  status: WfStepStatus;
  prompt_sent?: string | null;
  response?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  attempts: number;
  error?: string | null;
  interrupt?: {
    type: "input_required" | "tool_approval";
    interruptId: string;
    prompt?: string;
    fields?: unknown[];
    agent?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    allowedDecisions?: string[];
    toolApprovals?: Array<{
      tool_name: string;
      tool_args: Record<string, unknown>;
      tool_call_id: string;
      allowed_decisions: string[];
    }>;
  } | null;
}

export type WfRunVisibility = "private" | "workspace" | "admin";

export interface WfRun {
  _id: string;
  workflow_config_id: string;
  status: WfRunStatus;
  started_at?: string | null;
  completed_at?: string | null;
  current_step_index?: number | null;
  steps: WfStepRun[];
  user_context?: string | null;
  trigger_info?: { triggered_by: string; context?: Record<string, unknown> } | null;
  shared_with?: WfRunVisibility | null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Lightweight run summary for the sidebar list (no events) */
export interface WfRunSummary {
  _id: string;
  workflow_config_id: string;
  status: WfRunStatus;
  started_at?: string | null;
  completed_at?: string | null;
  current_step_index?: number | null;
  steps: WfStepRun[];
}

interface WorkflowExecState {
  /** All runs (sidebar list) */
  runs: WfRunSummary[];
  /** Whether we're loading the runs list */
  isLoadingRuns: boolean;
  /** Current run being viewed */
  run: WfRun | null;
  /** Events per step (step index → StreamEvent[]) */
  stepEvents: Record<number, StreamEvent[]>;
  /** Whether we're loading the run */
  isLoading: boolean;
  /** Error message */
  error: string | null;
  /** Polling interval ref */
  _pollRef: ReturnType<typeof setInterval> | null;

  /** Load all runs (for sidebar) */
  loadRuns: () => Promise<void>;
  /** Execute a workflow config → returns run ID */
  executeWorkflow: (workflowConfigId: string, userContext?: string) => Promise<string>;
  /** Load/poll a run */
  loadRun: (runId: string) => Promise<void>;
  /** Start polling a run every 2s */
  startPolling: (runId: string) => void;
  /** Stop polling */
  stopPolling: () => void;
  /** Resume an interrupted step */
  resumeStep: (runId: string, stepIndex: number, resumeData: string) => Promise<void>;
  /** Cancel a running workflow */
  cancelRun: (runId: string) => Promise<void>;
  /** Delete a workflow run (and its files/events) */
  deleteRun: (runId: string) => Promise<void>;
  /** Set sharing visibility for a run (owner only) */
  shareRun: (runId: string, visibility: WfRunVisibility) => Promise<void>;
  /** Clear state */
  clear: () => void;
}

export const useWorkflowExecStore = create<WorkflowExecState>()((set, get) => ({
  runs: [],
  isLoadingRuns: false,
  run: null,
  stepEvents: {},
  isLoading: false,
  error: null,
  _pollRef: null,

  loadRuns: async () => {
    set({ isLoadingRuns: true });
    try {
      const res = await fetch("/api/workflow-runs");
      if (!res.ok) throw new Error("Failed to load runs");
      const data = await res.json();
      const runs = Array.isArray(data)
        ? data.map((run) => ({
            ...run,
            steps: Array.isArray(run?.steps) ? run.steps : [],
          }))
        : [];
      set({ runs, isLoadingRuns: false });
    } catch {
      set({ isLoadingRuns: false });
    }
  },

  executeWorkflow: async (workflowConfigId, userContext) => {
    set({ isLoading: true, error: null, run: null, stepEvents: {} });
    try {
      const body: Record<string, unknown> = {
        workflow_config_id: workflowConfigId,
        trigger_info: { triggered_by: "webui" },
      };
      if (userContext) body.user_context = userContext;

      const res = await fetch("/api/workflow-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(await readWorkflowApiError(res));
      }

      const data = await res.json();
      const runId = data.run_id;
      if (!runId) throw new Error("No run_id in response");

      // Immediately load the run + refresh sidebar list
      await get().loadRun(runId);
      get().startPolling(runId);
      get().loadRuns();

      return runId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to execute workflow";
      set({ error: msg, isLoading: false });
      throw err;
    }
  },

  loadRun: async (runId) => {
    try {
      const url = `/api/workflow-runs?run_id=${encodeURIComponent(runId)}`;
      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err || `Load run failed: ${res.status}`);
      }

      const data = await res.json();
      // Separate events from run data
      const { events: eventsObj, ...runData } = data;

      // Convert events object keys to numbers
      const stepEvents: Record<number, StreamEvent[]> = {};
      if (eventsObj) {
        for (const [key, value] of Object.entries(eventsObj)) {
          stepEvents[parseInt(key, 10)] = value as StreamEvent[];
        }
      }

      set({
        run: runData as WfRun,
        stepEvents,
        isLoading: false,
        error: null,
      });

      // Auto-stop polling if run is terminal and refresh sidebar
      if (runData.status === "completed" || runData.status === "failed") {
        get().stopPolling();
        get().loadRuns();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load run";
      set({ error: msg, isLoading: false });
    }
  },

  startPolling: (runId) => {
    get().stopPolling();
    const ref = setInterval(() => {
      get().loadRun(runId);
    }, 2000);
    set({ _pollRef: ref });
  },

  stopPolling: () => {
    const ref = get()._pollRef;
    if (ref) {
      clearInterval(ref);
      set({ _pollRef: null });
    }
  },

  resumeStep: async (runId, stepIndex, resumeData) => {
    set({ error: null });
    try {
      const res = await fetch(`/api/workflow-runs/${encodeURIComponent(runId)}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step_index: stepIndex, resume_data: resumeData }),
      });

      if (!res.ok) {
        throw new Error(await readWorkflowApiError(res));
      }

      // Resume polling
      get().startPolling(runId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to resume";
      set({ error: msg });
      throw err;
    }
  },

  cancelRun: async (runId) => {
    set({ error: null });
    try {
      const res = await fetch(`/api/workflow-runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
      });

      if (!res.ok) {
        throw new Error(await readWorkflowApiError(res));
      }

      get().stopPolling();
      await get().loadRun(runId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to cancel";
      set({ error: msg });
      throw err;
    }
  },

  deleteRun: async (runId) => {
    set({ error: null });
    try {
      const res = await fetch(`/api/workflow-runs?id=${encodeURIComponent(runId)}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        throw new Error(await readWorkflowApiError(res));
      }

      // Remove from sidebar list
      set((s) => ({
        runs: s.runs.filter((r) => r._id !== runId),
        // Clear current run if it was the deleted one
        ...(s.run?._id === runId ? { run: null, stepEvents: {} } : {}),
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete";
      set({ error: msg });
      throw err;
    }
  },

  shareRun: async (runId, visibility) => {
    const res = await fetch(`/api/workflow-runs/${encodeURIComponent(runId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shared_with: visibility }),
    });
    if (!res.ok) {
      throw new Error(await readWorkflowApiError(res));
    }
    set((s) => ({
      run: s.run?._id === runId ? { ...s.run, shared_with: visibility } : s.run,
    }));
  },

  clear: () => {
    get().stopPolling();
    set({ run: null, stepEvents: {}, isLoading: false, error: null });
  },
}));
