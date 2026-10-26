/**
 * Workflow Engine — Server-side workflow orchestration.
 *
 * Fire-and-forget execution model:
 * - startWorkflowRun() creates a run doc and returns immediately
 * - executeSteps() runs in the background (no await)
 * - UI polls /api/workflow-runs for status updates
 *
 * Uses server-agui-consumer.ts to invoke DA agents via AG-UI SSE and
 * workflow-templating.ts to render Jinja2 prompt templates.
 */

import { getCollection } from "@/lib/mongodb";
import { readEvents } from "@/lib/server/event-store";
import { consumeAgentStream,type ConsumeResult } from "@/lib/streaming/clients/server-agui-consumer";
import { isToolStartData } from "@/lib/streaming/types";
import type { WorkflowConfig,WorkflowStep } from "@/types/workflow-config";
import { flattenStepEntries } from "@/types/workflow-config";
import { authorize, type Subject } from "@/lib/authz";
import { buildTemplateContext,renderPrompt,type StepContext } from "./workflow-templating";

/**
 * Decode the run owner's subject from the forwarded Bearer token. Per-step
 * agent-use is authorized in the UI server (this engine) via CAS — workflow
 * RBAC is a UI-server concept (the engine invokes agents one step at a time),
 * so DA no longer needs workflow_execution_authz. Returns null for system /
 * config-driven runs with no user token (already authorized at run start).
 */
// Exported for unit testing — extracts the run owner's `sub` from the forwarded
// Bearer so executeSteps can authorize per-step agent use against CAS.
export function runOwnerSubject(authHeaders: Record<string, string>): string | null {
  const auth = authHeaders["Authorization"] ?? authHeaders["authorization"];
  if (!auth?.startsWith("Bearer ")) return null;
  const parts = auth.slice(7).split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub.trim() ? sub.trim() : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════

const DA_SERVER_BASE_URL = process.env.DYNAMIC_AGENTS_URL || "http://localhost:8100";
const MAX_RUN_DURATION_SECONDS = parseInt(
  process.env.MAX_WORKFLOW_RUN_DURATION_SECONDS || "86400",
  10,
);
const CHECKPOINT_COLLECTION = process.env.WORKFLOW_CHECKPOINT_COLLECTION || "workflow_checkpoints";
const CHECKPOINT_TTL = parseInt(process.env.WORKFLOW_CHECKPOINT_TTL || "86400", 10);

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowStepRun {
  type: "step";
  index: number;
  display_text: string;
  agent_id: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "waiting_for_input";
  prompt_sent: string | null;
  response: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  attempts: number;
  error: string | null;
  interrupt: ConsumeResult["interrupt"] | null;
  conversation_id?: string;
}

export interface WorkflowRunTriggerInfo {
  triggered_by: "agent" | "webui" | string;
  context?: Record<string, unknown>;
}

export type WorkflowRunVisibility = "private" | "workspace" | "admin";

export interface WorkflowRunDocument {
  _id: string;
  workflow_config_id: string;
  owner_subject?: Subject | null;
  /** Who can view this run besides the owner. Defaults to "private". */
  shared_with?: WorkflowRunVisibility | null;
  status: WorkflowRunStatus;
  steps: WorkflowStepRun[];
  current_step_index: number;
  user_context: string | null;
  trigger_info?: WorkflowRunTriggerInfo | null;
  started_at: Date;
  completed_at: Date | null;
}

const RUNS_COLLECTION = "workflow_runs";

// ═══════════════════════════════════════════════════════════════
// In-memory abort controllers (for cancellation)
// ═══════════════════════════════════════════════════════════════

const activeAbortControllers = new Map<string, AbortController>();

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

/**
 * Start a workflow run (fire-and-forget).
 * Creates the run document and kicks off execution in the background.
 *
 * @returns The run_id
 */
export async function startWorkflowRun(
  config: WorkflowConfig,
  userContext: string | null,
  authHeaders: Record<string, string>,
  triggerInfo?: WorkflowRunTriggerInfo | null,
  ownerSubject?: Subject | null,
): Promise<string> {
  const runId = generateRunId();
  const flatSteps = flattenStepEntries(config.steps);
  const runOwner = ownerSubject ?? ownerSubjectFromAuthHeaders(authHeaders);

  const stepRuns: WorkflowStepRun[] = flatSteps.map(({ index, step }) => ({
    type: "step",
    index,
    display_text: step.display_text,
    agent_id: step.agent_id,
    status: "pending",
    prompt_sent: null,
    response: null,
    started_at: null,
    completed_at: null,
    attempts: 0,
    error: null,
    interrupt: null,
  }));

  const runDoc: WorkflowRunDocument = {
    _id: runId,
    workflow_config_id: config._id,
    owner_subject: runOwner,
    status: "running",
    steps: stepRuns,
    current_step_index: 0,
    user_context: userContext,
    trigger_info: triggerInfo || null,
    started_at: new Date(),
    completed_at: null,
  };

  const col = await getCollection<WorkflowRunDocument>(RUNS_COLLECTION);
  await col.insertOne(runDoc as unknown as Parameters<typeof col.insertOne>[0]);

  // Fire-and-forget
  const flatWorkflowSteps = flatSteps.map(({ step }) => step);
  executeSteps(runId, config._id, config.name, config.description, flatWorkflowSteps, userContext, authHeaders, 0, runOwner).catch((err) => {
    console.error(`[WorkflowEngine] Unhandled error in run ${runId}:`, err);
  });

  return runId;
}

/**
 * Resume a workflow run that's waiting for input.
 */
export async function resumeWorkflowRun(
  runId: string,
  stepIndex: number,
  resumeData: string,
  authHeaders: Record<string, string>,
): Promise<void> {
  const col = await getCollection<WorkflowRunDocument>(RUNS_COLLECTION);
  const run = await col.findOne({ _id: runId });
  if (!run) throw new Error(`Run ${runId} not found`);
  if (run.status !== "waiting_for_input") {
    throw new Error(`Run ${runId} is not waiting for input (status: ${run.status})`);
  }

  const step = run.steps[stepIndex];
  if (!step || step.status !== "waiting_for_input") {
    throw new Error(`Step ${stepIndex} is not waiting for input`);
  }

  // Load config to get step definitions
  const configCol = await getCollection<WorkflowConfig>("workflow_configs");
  const config = await configCol.findOne({ _id: run.workflow_config_id });
  if (!config) throw new Error(`Config ${run.workflow_config_id} not found`);

  const flatSteps = flattenStepEntries(config.steps).map(({ step: s }) => s);

  // Fire-and-forget: resume current step then continue
  resumeAndContinue(runId, run.workflow_config_id, config.name, config.description, stepIndex, resumeData, flatSteps, run.user_context, authHeaders, run.owner_subject ?? null).catch(
    (err) => {
      console.error(`[WorkflowEngine] Resume error in run ${runId}:`, err);
    },
  );
}

/**
 * Cancel a running workflow.
 */
export async function cancelWorkflowRun(runId: string): Promise<void> {
  // Abort any active stream
  const ac = activeAbortControllers.get(runId);
  if (ac) {
    ac.abort();
    activeAbortControllers.delete(runId);
  }

  const col = await getCollection<WorkflowRunDocument>(RUNS_COLLECTION);
  await col.updateOne(
    { _id: runId },
    { $set: { status: "cancelled" as WorkflowRunStatus, completed_at: new Date() } },
  );
}

/**
 * Check if a run has exceeded its max duration and mark it failed.
 * Called during polling (GET).
 */
export async function detectStaleRun(run: WorkflowRunDocument): Promise<boolean> {
  if (run.status !== "running" && run.status !== "waiting_for_input") return false;

  const elapsed = (Date.now() - new Date(run.started_at).getTime()) / 1000;
  if (elapsed <= MAX_RUN_DURATION_SECONDS) return false;

  const col = await getCollection<WorkflowRunDocument>(RUNS_COLLECTION);
  await col.updateOne(
    { _id: run._id },
    {
      $set: {
        status: "failed",
        completed_at: new Date(),
        [`steps.${run.current_step_index}.status`]: "failed",
        [`steps.${run.current_step_index}.error`]: "Run exceeded maximum duration",
      },
    },
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════
// Internal Execution
// ═══════════════════════════════════════════════════════════════

async function executeSteps(
  runId: string,
  workflowConfigId: string,
  workflowName: string,
  workflowDescription: string | undefined,
  steps: WorkflowStep[],
  userContext: string | null,
  authHeaders: Record<string, string>,
  startFrom: number,
  ownerSubject: Subject | null,
): Promise<void> {
  const col = await getCollection<WorkflowRunDocument>(RUNS_COLLECTION);
  const completedSteps: StepContext[] = [];

  // Reconstruct completed step contexts if resuming
  if (startFrom > 0) {
    const run = await col.findOne({ _id: runId });
    if (run) {
      for (let i = 0; i < startFrom; i++) {
        const s = run.steps[i];
        completedSteps.push({
          output: s.response,
          display_text: s.display_text,
          agent_id: s.agent_id,
          status: s.status,
          index: i,
          error: s.error,
        });
      }
    }
  }

  for (let i = startFrom; i < steps.length; i++) {
    const step = steps[i];

    // Per-step authorization gate (CAS) — the @subbaksh fix: workflow agent-use
    // is decided here in the UI server, not in DA. Org-admin bypass + standing
    // team/global grants apply via CAS. System runs (no owner token) skip this.
    //
    // Per-step agent-use is authorized here in the UI server via CAS. Standing
    // grants come from the share/agent-access modal (team→agent tuples) and
    // global wildcards; org admins pass via the CAS bypass. Set
    // WORKFLOW_CAS_STEP_GATE=false to fall back to DA-only gating.
    if (ownerSubject && process.env.WORKFLOW_CAS_STEP_GATE !== "false") {
      const decision = await authorize(
        {
          subject: ownerSubject,
          resource: { type: "agent", id: step.agent_id },
          action: "use",
          trustedContext: { workflowRunId: runId },
        },
        { correlationId: runId },
      );
      if (decision.decision !== "ALLOW") {
        await markStepFailed(col, runId, i, `Not authorized to use agent "${step.agent_id}" (${decision.reason})`);
        await markRunFailed(col, runId);
        return;
      }
    }

    // Mark step running
    await col.updateOne(
      { _id: runId },
      {
        $set: {
          current_step_index: i,
          [`steps.${i}.status`]: "running",
          [`steps.${i}.started_at`]: new Date(),
        },
      },
    );

    // Render prompt
    const templateCtx = buildTemplateContext(completedSteps, userContext);
    let renderedPrompt: string;
    try {
      renderedPrompt = renderPrompt(step.prompt, templateCtx);
    } catch (err) {
      await markStepFailed(col, runId, i, `Template error: ${(err as Error).message}`);
      if (step.on_error !== "skip") {
        await markRunFailed(col, runId);
        return;
      }
      completedSteps.push({
        output: null,
        display_text: step.display_text,
        agent_id: step.agent_id,
        status: "failed",
        index: i,
        error: (err as Error).message,
      });
      continue;
    }

    // Update prompt_sent
    await col.updateOne(
      { _id: runId },
      { $set: { [`steps.${i}.prompt_sent`]: renderedPrompt } },
    );

    // Build the full enriched prompt with workflow context wrapping the step instruction
    const enrichedPrompt = buildWorkflowContextPrefix(
      workflowName, workflowDescription, completedSteps, i, steps.length, renderedPrompt, step.agent_id,
    );

    // Execute with retry support
    const maxAttempts = step.on_error === "retry" ? (step.retry?.max_attempts ?? 3) : 1;
    let result: ConsumeResult | null = null;
    let stepError: string | null = null;
    let stepFilesWritten: string[] | undefined;
    let lastConversationId = "";
    let sourceId = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const previousError = stepError; // preserve for retry context
      stepError = null;
      sourceId = `${runId}-step-${i}-a${attempt}`;

      // On retry attempts, clean up previous attempt's state
      if (attempt > 1) {
        const fsNamespace = [workflowConfigId, runId, "filesystem"];
        await deleteStepArtifacts(fsNamespace, i, step.agent_id, authHeaders);
      }

      await col.updateOne(
        { _id: runId },
        { $set: { [`steps.${i}.attempts`]: attempt } },
      );

      const abortController = new AbortController();
      activeAbortControllers.set(runId, abortController);

      // Each attempt gets a fresh conversation
      const conversationId = `wf-${runId}-s${i}-a${attempt}`;
      lastConversationId = conversationId;

      // On retries, prepend context about the previous failure
      let attemptPrompt = enrichedPrompt;
      if (attempt > 1 && previousError) {
        attemptPrompt = `⚠️ RETRY CONTEXT: This is attempt ${attempt} of ${maxAttempts}. Your previous attempt failed with:\n${previousError}\n\nPlease try a different approach if possible.\n\n---\n\n${enrichedPrompt}`;
      }

      result = await consumeAgentStream({
        url: `${DA_SERVER_BASE_URL}/api/v1/chat/stream/start`,
        body: {
          message: attemptPrompt,
          conversation_id: conversationId,
          agent_id: step.agent_id,
          workflow_config_id: workflowConfigId,
          protocol: "agui",
          config_override: {
            backend: {
              config: {
                fs_namespace: [workflowConfigId, runId, "filesystem"],
                checkpoint_collection: CHECKPOINT_COLLECTION,
                checkpoint_ttl: CHECKPOINT_TTL,
              },
            },
            ...(step.config_override || {}),
          },
        },
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        sourceType: "workflow_step",
        sourceId: sourceId,
        signal: abortController.signal,
      });

      activeAbortControllers.delete(runId);

      // If interrupted, break immediately (not retriable)
      if (result.interrupted) break;

      // Check for stream/infra error
      if (result.error) {
        stepError = result.error;
      } else {
        // Stream succeeded — extract artifacts and check for agent-reported error.txt
        const fsNamespace = [workflowConfigId, runId, "filesystem"];
        const { toolCalls, filesWritten, fullOutput } = await extractStepArtifacts(sourceId);
        await writeStepArtifactsToFs(fsNamespace, i, step.agent_id, renderedPrompt, toolCalls, fullOutput, authHeaders);
        stepFilesWritten = filesWritten;

        const agentError = await checkAgentErrorFile(fsNamespace, i, step.agent_id, authHeaders);
        if (agentError) {
          stepError = agentError;
        }
      }

      // No error — success, break out
      if (!stepError) break;

      // If last attempt, don't retry
      if (attempt === maxAttempts) break;
    }

    if (!result) {
      await markStepFailed(col, runId, i, "No result from stream consumer");
      await markRunFailed(col, runId);
      return;
    }

    // Handle interrupt (pauses execution)
    if (result.interrupted) {
      const fsNamespace = [workflowConfigId, runId, "filesystem"];
      const { toolCalls, fullOutput } = await extractStepArtifacts(sourceId);
      await writeStepArtifactsToFs(fsNamespace, i, step.agent_id, renderedPrompt, toolCalls, fullOutput, authHeaders);
      const stepResponse = await resolveStepResponseText(sourceId, result.text);

      await col.updateOne(
        { _id: runId },
        {
          $set: {
            status: "waiting_for_input",
            [`steps.${i}.status`]: "waiting_for_input",
            [`steps.${i}.interrupt`]: result.interrupt,
            [`steps.${i}.response`]: stepResponse,
            [`steps.${i}.conversation_id`]: lastConversationId,
          },
        },
      );
      return; // Execution pauses until resume
    }

    // Handle failure (after all retries exhausted)
    if (stepError) {
      await markStepFailed(col, runId, i, stepError);

      // Write artifacts if we haven't already (stream-level errors)
      if (!stepFilesWritten) {
        const fsNamespace = [workflowConfigId, runId, "filesystem"];
        const { toolCalls, filesWritten, fullOutput } = await extractStepArtifacts(sourceId);
        await writeStepArtifactsToFs(fsNamespace, i, step.agent_id, renderedPrompt, toolCalls, fullOutput, authHeaders);
        stepFilesWritten = filesWritten;
      }

      if (step.on_error === "skip") {
        // Only "skip" continues to next step
        const stepResponse = await resolveStepResponseText(sourceId, result.text);
        completedSteps.push({
          output: stepResponse,
          display_text: step.display_text,
          agent_id: step.agent_id,
          status: "failed",
          index: i,
          error: stepError,
          filesWritten: stepFilesWritten,
        });
        await col.updateOne(
          { _id: runId },
          { $set: { [`steps.${i}.status`]: "skipped" } },
        );
        continue;
      }

      // "abort" and "retry" (after exhaustion) both terminate the workflow
      await markRunFailed(col, runId);
      return;
    }

    // Success
    const stepResponse = await resolveStepResponseText(sourceId, result.text);
    await col.updateOne(
      { _id: runId },
      {
        $set: {
          [`steps.${i}.status`]: "completed",
          [`steps.${i}.response`]: stepResponse,
          [`steps.${i}.completed_at`]: new Date(),
        },
      },
    );

    completedSteps.push({
      output: stepResponse,
      display_text: step.display_text,
      agent_id: step.agent_id,
      status: "completed",
      index: i,
      error: null,
      filesWritten: stepFilesWritten,
    });
  }

  // All steps completed
  await col.updateOne(
    { _id: runId },
    { $set: { status: "completed", completed_at: new Date() } },
  );
}

async function resumeAndContinue(
  runId: string,
  workflowConfigId: string,
  workflowName: string,
  workflowDescription: string | undefined,
  stepIndex: number,
  resumeData: string,
  steps: WorkflowStep[],
  userContext: string | null,
  authHeaders: Record<string, string>,
  ownerSubject: Subject | null,
): Promise<void> {
  const col = await getCollection<WorkflowRunDocument>(RUNS_COLLECTION);
  const step = steps[stepIndex];
  const runDoc = await col.findOne({ _id: runId });
  const attempt = runDoc!.steps[stepIndex].attempts || 1;
  const sourceId = `${runId}-step-${stepIndex}-a${attempt}`;
  const conversationId = runDoc!.steps[stepIndex].conversation_id!;

  // Mark running again
  await col.updateOne(
    { _id: runId },
    {
      $set: {
        status: "running",
        [`steps.${stepIndex}.status`]: "running",
        [`steps.${stepIndex}.interrupt`]: null,
      },
    },
  );

  const abortController = new AbortController();
  activeAbortControllers.set(runId, abortController);

  const result = await consumeAgentStream({
    url: `${DA_SERVER_BASE_URL}/api/v1/chat/stream/resume`,
    body: {
      conversation_id: conversationId,
      agent_id: step.agent_id,
      workflow_config_id: workflowConfigId,
      resume_data: resumeData,
      protocol: "agui",
      config_override: {
        backend: {
          config: {
            fs_namespace: [workflowConfigId, runId, "filesystem"],
            checkpoint_collection: CHECKPOINT_COLLECTION,
            checkpoint_ttl: CHECKPOINT_TTL,
          },
        },
        ...(step.config_override || {}),
      },
    },
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    sourceType: "workflow_step",
    sourceId: sourceId,
    signal: abortController.signal,
  });

  activeAbortControllers.delete(runId);

  if (result.interrupted) {
    const stepResponse = await resolveStepResponseText(sourceId, result.text);
    await col.updateOne(
      { _id: runId },
      {
        $set: {
          status: "waiting_for_input",
          [`steps.${stepIndex}.status`]: "waiting_for_input",
          [`steps.${stepIndex}.interrupt`]: result.interrupt,
          [`steps.${stepIndex}.response`]: stepResponse,
        },
      },
    );
    return;
  }

  if (result.error) {
    await markStepFailed(col, runId, stepIndex, result.error);
    const fsNamespace = [workflowConfigId, runId, "filesystem"];
    const { toolCalls, fullOutput } = await extractStepArtifacts(sourceId);
    const promptSent = runDoc!.steps[stepIndex]?.prompt_sent || "";
    await writeStepArtifactsToFs(fsNamespace, stepIndex, step.agent_id, promptSent, toolCalls, fullOutput, authHeaders);

    if (step.on_error === "skip") {
      // Continue to remaining steps
    } else {
      await markRunFailed(col, runId);
      return;
    }
  } else {
    const fsNamespace = [workflowConfigId, runId, "filesystem"];
    const { toolCalls, fullOutput } = await extractStepArtifacts(sourceId);
    const promptSent = runDoc!.steps[stepIndex]?.prompt_sent || "";
    await writeStepArtifactsToFs(fsNamespace, stepIndex, step.agent_id, promptSent, toolCalls, fullOutput, authHeaders);

    // Check if agent self-reported failure via error.txt
    const agentError = await checkAgentErrorFile(fsNamespace, stepIndex, step.agent_id, authHeaders);
    if (agentError) {
      await markStepFailed(col, runId, stepIndex, agentError);
      if (step.on_error === "skip") {
        // Continue to remaining steps
      } else {
        await markRunFailed(col, runId);
        return;
      }
    } else {
      const stepResponse = await resolveStepResponseText(sourceId, result.text);
      await col.updateOne(
        { _id: runId },
        {
          $set: {
            [`steps.${stepIndex}.status`]: "completed",
            [`steps.${stepIndex}.response`]: stepResponse,
            [`steps.${stepIndex}.completed_at`]: new Date(),
          },
        },
      );
    }
  }

  // Continue with remaining steps
  await executeSteps(runId, workflowConfigId, workflowName, workflowDescription, steps, userContext, authHeaders, stepIndex + 1, ownerSubject);
}

function ownerSubjectFromAuthHeaders(authHeaders: Record<string, string>): Subject | null {
  const sub = runOwnerSubject(authHeaders);
  return sub ? { type: "user", id: sub } : null;
}

// ═══════════════════════════════════════════════════════════════
// Step Artifacts & Context Helpers
// ═══════════════════════════════════════════════════════════════

const MAX_CONTEXT_STEPS = 10;

/**
 * Extract tool call summaries and files written from persisted stream events.
 * Also reconstructs the full agent output from all content events.
 */
async function extractStepArtifacts(sourceId: string): Promise<{
  toolCalls: string[];
  filesWritten: string[];
  fullOutput: string;
  toolResults: string[];
}> {
  const events = await readEvents("workflow_step", sourceId);
  const toolStarts = new Map<string, { name: string; args: Record<string, unknown> }>();
  const toolCalls: string[] = [];
  const filesWritten: string[] = [];
  const toolResults: string[] = [];
  let fullOutput = "";

  for (const ev of events) {
    if (ev.type === "content" && ev.content) {
      fullOutput += ev.content;
    }
    if (ev.type === "tool_start" && ev.toolData && isToolStartData(ev.toolData)) {
      toolStarts.set(ev.toolData.tool_call_id, {
        name: ev.toolData.tool_name,
        args: ev.toolData.args || {},
      });
    }
    if (ev.type === "tool_end" && ev.toolData && !isToolStartData(ev.toolData)) {
      const start = toolStarts.get(ev.toolData.tool_call_id);
      if (start) {
        const argsStr = Object.entries(start.args)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(", ");
        const status = ev.toolData.error ? "failed" : "success";
        toolCalls.push(`[call] ${start.name}(${argsStr}) → ${status}`);
        if (start.name === "write_file" && start.args.path) {
          filesWritten.push(String(start.args.path));
        }
      }
      if (ev.toolData.result?.trim()) {
        toolResults.push(ev.toolData.result.trim());
      }
    }
  }
  return { toolCalls, filesWritten, fullOutput, toolResults };
}

/** Pick assistant text for step output, falling back to tool results only when no text exists. */
export async function resolveStepResponseText(
  sourceId: string,
  streamText: string | undefined | null,
): Promise<string | null> {
  const { fullOutput, toolResults } = await extractStepArtifacts(sourceId);
  const textCandidates = [
    streamText?.trim(),
    fullOutput.trim(),
  ].filter((value): value is string => Boolean(value));
  if (textCandidates.length > 0) {
    return textCandidates.reduce((longest, current) =>
      current.length > longest.length ? current : longest,
    );
  }

  const toolResultCandidates = toolResults.map((result) => result.trim()).filter(Boolean);
  if (toolResultCandidates.length === 0) return null;
  return toolResultCandidates.reduce((longest, current) =>
    current.length > longest.length ? current : longest,
  );
}

/**
 * Write step artifacts (prompt, tool calls, output) to the workflow filesystem namespace.
 */
async function writeStepArtifactsToFs(
  fsNamespace: string[],
  stepIndex: number,
  agentId: string,
  promptSent: string,
  toolCalls: string[],
  agentOutput: string,
  authHeaders: Record<string, string>,
): Promise<void> {
  const dir = `/workflow-state/step-${stepIndex + 1}--${agentId}`;
  const files = [
    { path: `${dir}/user_prompt.txt`, content: promptSent },
    { path: `${dir}/tool_calls.txt`, content: toolCalls.join("\n") || "(no tool calls)" },
    { path: `${dir}/agent_output.txt`, content: agentOutput || "(no output)" },
  ];
  for (const f of files) {
    try {
      const response = await fetch(`${DA_SERVER_BASE_URL}/api/v1/files/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ fs_namespace: fsNamespace, path: f.path, content: f.content }),
      });
      if (!response.ok) {
        throw new Error(`Artifact write returned HTTP ${response.status}`);
      }
    } catch (err) {
      console.error(`[WorkflowEngine] Failed to write artifact ${f.path}:`, err);
    }
  }
}

/**
 * Build a workflow context prefix to prepend to the step's user prompt.
 * Provides the agent with workflow awareness, previous step context, and critical instructions.
 */
export function buildWorkflowContextPrefix(
  workflowName: string,
  workflowDescription: string | undefined,
  completedSteps: StepContext[],
  stepIndex: number,
  totalSteps: number,
  stepPrompt: string,
  agentId: string,
): string {
  let ctx = "";

  // --- Overview ---
  ctx += "This interaction is part of a larger workflow.\n\n";
  ctx += "## Workflow Execution\n";
  ctx += "A workflow is an automated multi-step pipeline where each step is handled by an agent. ";
  ctx += "You are one agent executing one step in this pipeline.\n\n";

  // --- Investigating workflow files ---
  ctx += "## Investigating Workflow Files\n";
  ctx += "The workflow engine deterministically populates `workflow-state/` after each step. Treat the entire directory as read-only reference material for investigation, except for the step-specific error file described below. Never create, modify, or delete any other file under `workflow-state/`.\n";
  ctx += "Previous-step logs are stored under `workflow-state/step-{N}--{agent-id}/`. You may use `ls` and `read_file` to inspect user_prompt.txt, tool_calls.txt, and agent_output.txt.\n";
  ctx += "Other steps may write shared files at the filesystem root, outside `workflow-state/`. Run `ls /` to discover those files when investigating previous work.\n\n";

  // --- Critical: User interaction ---
  ctx += "## Critical: User Interaction\n";
  ctx += "The user does NOT have access to this chat. All interaction with the user must happen through the `request_user_input` tool.\n";
  ctx += "When a step must pass data to later steps, call `request_user_input` if needed, then persist outputs with `write_file` at the filesystem root (for example `/choices.txt`), never under `workflow-state/`; the failure marker below is the sole exception.\n";
  ctx += "If that tool is not available and you cannot proceed without user input, use the failure-reporting file below and stop.\n\n";

  // --- Critical: Reporting failure ---
  ctx += "## Critical: Reporting Failure\n";
  ctx += `If you determine this step has failed or you cannot complete the task, write a brief explanation to \`workflow-state/step-${stepIndex + 1}--${agentId}/error.txt\` using \`write_file\`.\n`;
  ctx += "This error file is the only path you may write under `workflow-state/`.\n";
  ctx += "The workflow engine will detect this file and mark the step as failed.\n\n";

  // --- Workflow identity ---
  ctx += "---\n\n";
  ctx += "## The workflow you are executing\n";
  ctx += `**Workflow name:** ${workflowName}\n`;
  if (workflowDescription) ctx += `**Workflow description:** ${workflowDescription}\n`;
  ctx += "\n";

  // --- Previous steps summary ---
  if (completedSteps.length > 0) {
    const visible =
      completedSteps.length > MAX_CONTEXT_STEPS
        ? completedSteps.slice(-MAX_CONTEXT_STEPS)
        : completedSteps;

    ctx += "## Summary of Previous Steps\n";
    if (completedSteps.length > MAX_CONTEXT_STEPS) {
      ctx += `(showing latest ${MAX_CONTEXT_STEPS} of ${completedSteps.length} steps)\n`;
    }
    for (const s of visible) {
      ctx += `- Step ${s.index + 1}: "${s.display_text}" (agent: ${s.agent_id}) — ${s.status}`;
      if (s.filesWritten?.length) ctx += `\n  Files written: ${s.filesWritten.join(", ")}`;
      ctx += "\n";
    }
    ctx += "\n";
  }

  // --- Current step ---
  ctx += "---\n\n";
  ctx += `You are executing **step ${stepIndex + 1} of ${totalSteps}**.\n\n`;
  ctx += "Interpret and act on this step in the context of the overall workflow — not in isolation. ";
  ctx += "Consider what previous steps have accomplished and what subsequent steps may need from you.\n\n";
  ctx += "With that in mind, the instruction for this step is:\n\n";
  ctx += "```\n";
  ctx += stepPrompt;
  ctx += "\n```\n";

  return ctx;
}

/**
 * Check if the agent wrote an error.txt file to signal step failure.
 * Returns the error content if found, null otherwise.
 */
async function checkAgentErrorFile(
  fsNamespace: string[],
  stepIndex: number,
  agentId: string,
  authHeaders: Record<string, string>,
): Promise<string | null> {
  // Check both with and without leading slash (agents may write either way)
  const paths = [
    `workflow-state/step-${stepIndex + 1}--${agentId}/error.txt`,
    `/workflow-state/step-${stepIndex + 1}--${agentId}/error.txt`,
  ];
  for (const path of paths) {
    try {
      const res = await fetch(
        `${DA_SERVER_BASE_URL}/api/v1/files/content?fs_namespace=${encodeURIComponent(JSON.stringify(fsNamespace))}&path=${encodeURIComponent(path)}`,
        { headers: authHeaders },
      );
      if (res.ok) {
        const body = await res.json();
        return body?.content || "Agent reported failure (no details)";
      }
    } catch {
      // File not found or network error — continue to next path
    }
  }
  return null;
}

/** Delete all step artifacts before a retry attempt so only the final attempt's files remain */
async function deleteStepArtifacts(
  fsNamespace: string[],
  stepIndex: number,
  agentId: string,
  authHeaders: Record<string, string>,
): Promise<void> {
  const prefixes = [
    `workflow-state/step-${stepIndex + 1}--${agentId}/`,
    `/workflow-state/step-${stepIndex + 1}--${agentId}/`,
  ];
  const filenames = ["error.txt", "user_prompt.txt", "tool_calls.txt", "agent_output.txt"];
  for (const prefix of prefixes) {
    for (const filename of filenames) {
      try {
        await fetch(
          `${DA_SERVER_BASE_URL}/api/v1/files/content?fs_namespace=${encodeURIComponent(JSON.stringify(fsNamespace))}&path=${encodeURIComponent(prefix + filename)}`,
          { method: "DELETE", headers: authHeaders },
        );
      } catch {
        // Ignore — file may not exist
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function generateRunId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const rand = Math.random().toString(16).slice(2, 10);
  return `wfrun-${ts}-${rand}`;
}

async function markStepFailed(
  col: Awaited<ReturnType<typeof getCollection<WorkflowRunDocument>>>,
  runId: string,
  stepIndex: number,
  error: string,
): Promise<void> {
  console.error(`[WorkflowEngine] Step ${stepIndex} failed in run ${runId}: ${error}`);
  await col.updateOne(
    { _id: runId },
    {
      $set: {
        [`steps.${stepIndex}.status`]: "failed",
        [`steps.${stepIndex}.error`]: error,
        [`steps.${stepIndex}.completed_at`]: new Date(),
      },
    },
  );
}

async function markRunFailed(
  col: Awaited<ReturnType<typeof getCollection<WorkflowRunDocument>>>,
  runId: string,
): Promise<void> {
  await col.updateOne(
    { _id: runId },
    { $set: { status: "failed", completed_at: new Date() } },
  );
}
