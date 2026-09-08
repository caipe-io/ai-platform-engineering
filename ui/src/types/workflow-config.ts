import type { AuthzSyncMetadata } from "./authz-sync";

/**
 * Workflow Config Types
 *
 * TypeScript types mirroring the Python Pydantic models in
 * ai_platform_engineering/workflows/src/workflow_service/storage/models.py
 *
 * These define multi-step workflows that the Workflow Service executes
 * by invoking dynamic agents via AG-UI. Stored in MongoDB `workflow_configs`.
 */

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

export type WorkflowConfigVisibility = "private" | "team" | "global";

// ---------------------------------------------------------------------------
// Step & Parallel Group (discriminated union via `type`)
// ---------------------------------------------------------------------------

export interface RetryConfig {
  max_attempts: number; // default 3
}

export interface WorkflowStep {
  type: "step";
  /** UI label displayed for this step */
  display_text: string;
  /** Dynamic agent _id to invoke */
  agent_id: string;
  /** Jinja2 prompt template (rendered at execution time) */
  prompt: string;
  /** Error handling policy */
  on_error: "abort" | "skip" | "retry";
  /** Retry config — only relevant when on_error is "retry" */
  retry?: RetryConfig | null;
  /** Per-step config override passed to the DA server (system_prompt, allowed_tools, model, etc.) */
  config_override?: Record<string, unknown> | null;
}

export interface ParallelGroup {
  type: "parallel";
  /** Steps to run concurrently (v2 only) */
  steps: WorkflowStep[];
  /** Group-level error policy */
  on_error: "abort" | "skip";
}

export type StepEntry = WorkflowStep | ParallelGroup;

// ---------------------------------------------------------------------------
// Workflow Config (MongoDB document)
// ---------------------------------------------------------------------------

export interface WorkflowConfig extends AuthzSyncMetadata {
  /** Unique identifier (MongoDB _id), e.g. "wf-<timestamp>-<random>" */
  _id: string;
  /** Workflow name (unique) */
  name: string;
  /** Optional description */
  description?: string | null;
  /** Ordered list of steps (v1: only WorkflowStep, no ParallelGroup) */
  steps: StepEntry[];
  /** Creator's email */
  owner_id: string;
  /** Stable OIDC subject used for ownership checks and reconciliation. */
  owner_subject?: string;
  /** Visibility level */
  visibility: WorkflowConfigVisibility;
  /** Team IDs when visibility is "team" */
  shared_with_teams?: string[] | null;
  /** Whether this workflow was seeded from app-config.yaml (read-only in UI) */
  config_driven?: boolean;
  /** Creation timestamp */
  created_at: Date | string;
  /** Last update timestamp */
  updated_at: Date | string;
}

// ---------------------------------------------------------------------------
// Create / Update inputs
// ---------------------------------------------------------------------------

export interface CreateWorkflowConfigInput {
  name: string;
  description?: string;
  steps: StepEntry[];
  visibility?: WorkflowConfigVisibility;
  shared_with_teams?: string[];
}

export interface UpdateWorkflowConfigInput {
  name?: string;
  description?: string;
  steps?: StepEntry[];
  visibility?: WorkflowConfigVisibility;
  shared_with_teams?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a blank WorkflowStep with sensible defaults */
export function createBlankStep(
  overrides?: Partial<WorkflowStep>,
): WorkflowStep {
  return {
    type: "step",
    display_text: "",
    agent_id: "",
    prompt: "",
    on_error: "abort",
    retry: null,
    config_override: null,
    ...overrides,
  };
}

/** Flatten StepEntry[] into a flat list of (globalIndex, WorkflowStep) tuples */
export function flattenStepEntries(
  entries: StepEntry[],
): { index: number; step: WorkflowStep }[] {
  const result: { index: number; step: WorkflowStep }[] = [];
  let idx = 0;
  for (const entry of entries) {
    if (entry.type === "step") {
      result.push({ index: idx, step: entry });
      idx++;
    } else {
      // parallel group — each sub-step gets its own global index
      for (const sub of entry.steps) {
        result.push({ index: idx, step: sub });
        idx++;
      }
    }
  }
  return result;
}
