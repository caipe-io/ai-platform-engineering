import type { Subject } from "@/lib/authz";
import { publishNotificationRequest } from "@/lib/notifications/fanout.server";

export type WorkflowNotificationKind = "started" | "completed" | "failed" | "requires_input";

interface WorkflowNotificationInput {
  kind: WorkflowNotificationKind;
  runId: string;
  workflowName?: string;
  owner: Subject | null | undefined;
  /** Distinguishes repeated pauses within one run, such as one per step. */
  stepIndex?: number;
  /** Replaces the default summary. Must stay free of prompts and tool output. */
  summary?: string;
}

// Generic copy only. Step errors, prompts and agent output can contain
// sensitive data, so they never appear in a notification. The run page has
// the detail for people who are allowed to see it.
const COPY: Record<WorkflowNotificationKind, { title: string; summary: (name: string) => string; status: string }> = {
  started: { title: "Workflow started", summary: (name) => `${name} started.`, status: "running" },
  completed: { title: "Workflow completed", summary: (name) => `${name} finished.`, status: "completed" },
  failed: {
    title: "Workflow failed",
    summary: (name) => `${name} stopped with an error. Open the run for details.`,
    status: "failed",
  },
  requires_input: {
    title: "Workflow needs your input",
    summary: (name) => `${name} is waiting for your answer.`,
    status: "waiting_for_input",
  },
};

/**
 * Tells the run's owner about a workflow lifecycle change. Never throws and
 * never blocks the run: publishing problems are logged inside the publisher.
 * Runs owned by service accounts are skipped, since they have no inbox.
 */
export async function notifyWorkflowEvent(input: WorkflowNotificationInput): Promise<void> {
  try {
    if (!input.owner || input.owner.type !== "user") return;

    const copy = COPY[input.kind];
    const name = input.workflowName?.trim() || "A workflow";
    const attemptId =
      input.kind === "requires_input" && input.stepIndex !== undefined
        ? `${input.runId}:step-${input.stepIndex}`
        : input.runId;

    await publishNotificationRequest({
      base: {
        id: `workflow.${input.kind}:${attemptId}`,
        type: `workflow.${input.kind}`,
        version: 1,
        occurred_at: new Date().toISOString(),
        resource: { type: "workflow_run", id: input.runId },
        attempt_id: attemptId,
        data: {
          status: copy.status,
          title: copy.title,
          summary: input.summary ?? copy.summary(name),
          href: `/workflows/run/${encodeURIComponent(input.runId)}`,
        },
      },
      recipients: [{ subject: input.owner.id }],
      includeOrgAdmins: false,
    });
  } catch (error) {
    console.error("[WorkflowEngine] notification failed", input.kind, input.runId, error);
  }
}
