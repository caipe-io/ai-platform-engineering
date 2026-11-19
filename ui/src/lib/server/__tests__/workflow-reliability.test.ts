/** @jest-environment node */

jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn() }));
jest.mock("@/lib/server/event-store", () => ({ readEvents: jest.fn().mockResolvedValue([]) }));
jest.mock("@/lib/authz", () => ({ authorize: jest.fn() }));
jest.mock("@/lib/streaming/clients/server-agui-consumer", () => ({ consumeAgentStream: jest.fn() }));

import { getCollection } from "@/lib/mongodb";
import { consumeAgentStream } from "@/lib/streaming/clients/server-agui-consumer";
import type { WorkflowConfig } from "@/types/workflow-config";
import { cancelWorkflowRun, detectStaleRun, resumeWorkflowRun, startWorkflowRun, type WorkflowRunDocument } from "../workflow-engine";
import { launchWorkflowExecution } from "../workflow-execution";

let run: WorkflowRunDocument;
const consumer = consumeAgentStream as jest.Mock;
const updateOne = jest.fn();
const findOne = jest.fn();
const originalFetch = global.fetch;

function config(onError = "abort"): WorkflowConfig {
  return { _id: "example-workflow", name: "Example", steps: [0, 1].map((i) => ({
    type: "step", agent_id: "example-agent", display_text: `Step ${i}`, prompt: "Perform the example step",
    on_error: onError, retry: { max_attempts: 3 },
  })) } as WorkflowConfig;
}

function matches(filter: Record<string, unknown>): boolean {
  if (!run) return false;
  return Object.entries(filter).every(([key, value]) => {
    const actual = run[key as keyof WorkflowRunDocument];
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const op = value as Record<string, unknown>;
      if ("$in" in op) return (op.$in as unknown[]).includes(actual);
      if ("$ne" in op) return actual !== op.$ne;
      if ("$lte" in op) return Number(actual) <= Number(op.$lte);
      if ("$gt" in op) return Number(actual) > Number(op.$gt);
    }
    return actual === value;
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  (getCollection as jest.Mock).mockResolvedValue({
    insertOne: async (doc: WorkflowRunDocument) => { run = structuredClone(doc); }, updateOne, findOne,
  });
  findOne.mockImplementation(async (filter) => matches(filter) ? structuredClone(run) : null);
  updateOne.mockImplementation(async (filter, update) => {
    if (!matches(filter)) return { matchedCount: 0 };
    for (const [path, value] of Object.entries(update.$set ?? {})) {
      const keys = path.split(".");
      let target = run as unknown as Record<string, unknown>;
      for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
      target[keys.at(-1)!] = value;
    }
    for (const key of Object.keys(update.$unset ?? {})) delete (run as unknown as Record<string, unknown>)[key];
    return { matchedCount: 1 };
  });
  global.fetch = jest.fn(async (_url, init) => new Response(null, { status: init?.method === "PUT" || init?.method === "DELETE" ? 200 : 404 }));
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
  global.fetch = originalFetch;
});

async function drain(): Promise<void> { await jest.advanceTimersByTimeAsync(0); }

it.each(["retry", "skip"])("does not replay or advance an uncertain external action with on_error=%s", async (policy) => {
  consumer.mockResolvedValue({ text: "", error: "Completion unconfirmed", interrupted: false, retryable: false });
  await startWorkflowRun(config(policy), null, {});
  await drain();
  expect(consumer).toHaveBeenCalledTimes(1);
  expect(run.status).toBe("failed");
  expect(run.steps[1].status).toBe("pending");
  expect(run.steps[0].conversation_id).toBeTruthy();
});

it("persists an unexpected execution exception as failure instead of leaving Running", async () => {
  consumer.mockRejectedValue(new Error("Dependency disconnected"));
  await startWorkflowRun(config(), null, {});
  await drain();
  expect(run.status).toBe("failed");
  expect(run.steps[0].error).toContain("Dependency disconnected");
});

it("does not overwrite cancellation or invoke the next step when a late result arrives", async () => {
  let complete!: (result: unknown) => void;
  consumer.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const id = await startWorkflowRun(config(), null, {});
  await drain();
  await cancelWorkflowRun(id);
  complete({ text: "Committed", interrupted: false });
  await drain();
  expect(run.status).toBe("cancelled");
  expect(consumer).toHaveBeenCalledTimes(1);
  expect(run.steps[1].status).toBe("pending");
});

it("fails instead of advancing when the next step's artifacts cannot be persisted", async () => {
  consumer.mockResolvedValue({ text: "Completed", interrupted: false });
  global.fetch = jest.fn(async () => new Response(null, { status: 503 }));
  await startWorkflowRun(config(), null, {});
  await drain();
  expect(run.status).toBe("failed");
  expect(run.steps[0].error).toContain("Artifact write returned HTTP 503");
  expect(consumer).toHaveBeenCalledTimes(1);
});

it("keeps an ordinary explicitly completed workflow successful", async () => {
  consumer.mockResolvedValue({ text: "Completed", interrupted: false });
  await startWorkflowRun(config(), null, {});
  await drain();
  expect(run.status).toBe("completed");
  expect(run.steps.map((step) => step.status)).toEqual(["completed", "completed"]);
  expect(consumer).toHaveBeenCalledTimes(2);
  await cancelWorkflowRun(run._id);
  expect(run.status).toBe("completed");
});

it("renews a live worker's lease and rejects a duplicate resume claim", async () => {
  let finish!: (result: unknown) => void;
  consumer.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const id = await startWorkflowRun(config(), null, {});
  await drain();
  const first = run.lease_expires_at!.getTime();
  await jest.advanceTimersByTimeAsync(15_000);
  expect(run.lease_expires_at!.getTime()).toBeGreaterThan(first);
  const duplicate = jest.fn();
  await expect(launchWorkflowExecution(id, "waiting_for_input", duplicate)).rejects.toThrow("already claimed");
  expect(duplicate).not.toHaveBeenCalled();
  finish({ text: "", error: "Stopped", interrupted: false, retryable: false });
  await drain();
});

it.each(["pending", "running"] as const)("marks a lost %s worker failed on polling without replaying tools", async (status) => {
  consumer.mockResolvedValue({ text: "", interrupted: true, interrupt: { type: "input_required", interruptId: "example-input" } });
  await startWorkflowRun(config(), null, {});
  await drain();
  // Simulate the durable document left by a worker that disappeared after admission.
  run.status = status;
  run.execution_id = "lost-worker";
  if (status === "pending") delete run.execution_id;
  run.lease_expires_at = new Date(Date.now() - 1);
  expect(await detectStaleRun(run)).toBe(true);
  expect(run.status).toBe("failed");
  expect(run.steps[0].error).toContain("heartbeat expired");
  expect(consumer).toHaveBeenCalledTimes(1);
});

it("does not expire a run whose heartbeat renewed after the polling snapshot", async () => {
  consumer.mockResolvedValue({ text: "", interrupted: true, interrupt: { type: "input_required", interruptId: "example-input" } });
  await startWorkflowRun(config(), null, {});
  await drain();
  run.status = "running";
  run.execution_id = "live-worker";
  run.lease_expires_at = new Date(Date.now() - 1);
  const snapshot = structuredClone(run);
  run.lease_expires_at = new Date(Date.now() + 90_000);
  expect(await detectStaleRun(snapshot)).toBe(false);
  expect(run.status).toBe("running");
});

it("does not treat waiting for human input as a lost worker", async () => {
  consumer.mockResolvedValue({ text: "", interrupted: true, interrupt: { type: "input_required", interruptId: "example-input" } });
  await startWorkflowRun(config(), null, {});
  await drain();
  await jest.advanceTimersByTimeAsync(120_000);
  expect(await detectStaleRun(run)).toBe(false);
  expect(run.status).toBe("waiting_for_input");
});

it("admits only one of two concurrent human-input resumes", async () => {
  consumer.mockResolvedValue({ text: "", interrupted: true, interrupt: { type: "input_required", interruptId: "example-input" } });
  const id = await startWorkflowRun(config(), null, {});
  await drain();
  (getCollection as jest.Mock).mockImplementation(async (name) => name === "workflow_configs"
    ? { findOne: async () => config() } : { updateOne, findOne });
  const results = await Promise.allSettled([
    resumeWorkflowRun(id, 0, { answer: "primary" }, {}),
    resumeWorkflowRun(id, 0, { answer: "secondary" }, {}),
  ]);
  await drain();
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(consumer).toHaveBeenCalledTimes(2);
});

it("aborts a worker that cannot renew its lease and does not admit another step", async () => {
  let finish!: (result: unknown) => void;
  consumer.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await startWorkflowRun(config(), null, {});
  await drain();
  const signal = consumer.mock.calls[0][0].signal as AbortSignal;
  run.lease_expires_at = new Date(Date.now() - 1);
  await jest.advanceTimersByTimeAsync(15_000);
  expect(signal.aborted).toBe(true);
  finish({ text: "Late success", interrupted: false });
  await drain();
  expect(run.status).toBe("failed");
  expect(consumer).toHaveBeenCalledTimes(1);
});
