import { getCoordinationFeatures } from "./features.server";
import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, type AuthResult } from "@/lib/da-proxy";
import { ApiError } from "@/lib/api-error";
import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { getStoredSession, refreshSession, SessionExpiredError } from "@/lib/auth-token-store";
import { exchangeRefreshToken } from "@/lib/auth-token-refresh";
import { authorizeConversationWriteAccess } from "@/app/api/v1/chat/_conversation-authz";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";
import { conversationHasAgent, handoffAssistantMessageId } from "@/lib/chat-coordination";
import { getAgentId } from "@/types/a2a";
import type { Conversation } from "@/types/mongodb";
import type { HarnessRun, HarnessRunEvent } from "@/types/harness-engine";
import { getHarnessEngineConfig, proxyHarnessEngine } from "@/lib/harness-engine-proxy";
import { resolveHarnessGatewayTarget, startHarnessGatewayRun } from "@/lib/harness-gateway";
import { dueDelivery, deliveryLease, type HandoffDeliveryState } from "./lease";
import { coordinationPolicy, type CoordinationPolicy } from "./policy.server";
import { HANDOFF_SCHEMA, HANDOFF_TOOL, handoffKey, MAX_HANDOFF_DEPTH, MAX_HANDOFFS, parseHandoff } from "./contracts";

interface Handoff extends HandoffDeliveryState {
  conversationId: string; generation: string; owner: string; parentRunId: string;
  sourceAgentId: string; targetAgentId: string; handle: string; message: string;
  recipientEmail?: string; root: string; depth: number; runId?: string;
}
const jobs = () => getCollection<Handoff>("chat_agent_handoffs");

function participants(chat: Conversation) {
  return [{ agent_id: getAgentId(chat), handle: "primary", name: "Primary agent" }, ...(chat.coordination_agents ?? [])];
}

async function enabledPolicy(run: HarnessRun) {
  if (!(await getCoordinationFeatures()).team) return null;
  const policy = await coordinationPolicy(run.conversation_id);
  if (!policy || policy.mode !== "team" || policy.owner !== run.owner_subject || !policy.sessionId || policy.expiresAt <= new Date()) return null;
  return policy;
}

export async function handoffTools(run: HarnessRun) {
  if (!await enabledPolicy(run)) return [];
  const chat = await (await getCollection<Conversation>("conversations")).findOne({ _id: run.conversation_id, deleted_at: null });
  if (!chat || !conversationHasAgent(chat, run.agent_id)) return [];
  const targets = participants(chat).filter(member => member.agent_id !== run.agent_id);
  if (!targets.length) return [];
  return [{ tool_id: HANDOFF_TOOL, description: `Assign one self-contained task to a joined agent. Runs after this turn completes. Targets: ${targets.map(t => `@${t.handle} (${t.name})`).join(", ")}. Maximum ${MAX_HANDOFFS} handoffs and ${MAX_HANDOFF_DEPTH} hops per chain. Results are published in this same chat, and the primary receives published replies on its next turn. Queued acknowledgement is not completion. This does not share your full transcript or files. Do not wait for the result inside this turn.`, input_schema: HANDOFF_SCHEMA }];
}

export async function enqueueHandoff(run: HarnessRun, auth: AuthResult, input: unknown) {
  let args: ReturnType<typeof parseHandoff>;
  try { args = parseHandoff(input); } catch { throw new ApiError("Invalid handoff assignment", 400); }
  const policy = await enabledPolicy(run);
  if (!policy || run.status !== "running" || run.cancellation_requested || auth.subject !== policy.owner) throw new ApiError("Team coordination requires an active owner run", 409);
  const access = await authorizeConversationWriteAccess(auth, run.conversation_id, run.agent_id);
  if (access.denial) throw new ApiError("Chat access denied", 403);
  const target = participants(access.conversation).find(member => member.handle === args.handle);
  if (!target?.agent_id || target.agent_id === run.agent_id) throw new ApiError("Choose a different joined agent", 400);
  if (await requireAgentUsePermission({ ...auth, agentId: target.agent_id })) throw new ApiError("Target agent access denied", 403);
  const collection = await jobs();
  const id = handoffKey(run.run_id, target.agent_id, args.message);
  const existing = await collection.findOne({ _id: id });
  if (existing) return { id, status: existing.status };
  const parent = await collection.findOne({ runId: run.run_id, owner: policy.owner, generation: policy.generation });
  const depth = (parent?.depth ?? 0) + 1;
  if (depth > MAX_HANDOFF_DEPTH) throw new ApiError("Handoff chain reached its hop limit", 409);
  const root = parent?.root ?? run.run_id;
  // Reserve a bounded idempotent slot before acceptance. A crash can consume a
  // slot, but can never exceed the chain budget or duplicate an execution.
  const budgets = await getCollection<{ _id: string; ids: string[]; expiresAt: Date }>("chat_handoff_budgets");
  await budgets.updateOne({ _id: root }, { $setOnInsert: { ids: [], expiresAt: new Date(Date.now() + 86400_000) } }, { upsert: true });
  const budget = await budgets.updateOne({ _id: root, $or: [{ ids: id }, { [`ids.${MAX_HANDOFFS - 1}`]: { $exists: false } }] }, { $addToSet: { ids: id } });
  if (!budget.matchedCount) throw new ApiError("Handoff chain reached its task limit", 409);
  const now = new Date();
  await collection.updateOne({ _id: id }, { $setOnInsert: {
    recipientEmail: auth.email, conversationId: run.conversation_id, generation: policy.generation, owner: policy.owner,
    parentRunId: run.run_id, sourceAgentId: run.agent_id, targetAgentId: target.agent_id,
    handle: args.handle, message: args.message, root, depth, status: "pending", attempts: 0,
    availableAt: now, createdAt: now, updatedAt: now, expiresAt: new Date(Math.min(policy.expiresAt.getTime(), now.getTime() + 86400_000)),
  } }, { upsert: true });
  return { id, status: "pending" };
}

async function executionAuth(policy: CoordinationPolicy): Promise<AuthResult> {
  if (!policy.sessionId) throw new SessionExpiredError();
  let session = await getStoredSession(policy.sessionId, policy.owner);
  if (session.expiresAt <= Date.now() / 1000 + 30) session = await refreshSession(policy.sessionId, policy.owner, session.sessionVersion, exchangeRefreshToken);
  // Validate signature, current account and authorization through the normal BFF boundary.
  const auth = await authenticateRequest(new NextRequest("http://localhost/api/coordination", { headers: { Authorization: `Bearer ${session.accessToken}` } }));
  if (auth instanceof NextResponse || auth.subject !== policy.owner || auth.isServiceAccount) throw new SessionExpiredError();
  return auth;
}

async function readRun(auth: AuthResult, runId: string): Promise<HarnessRun> {
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) throw new Error("engine_unavailable");
  const response = await proxyHarnessEngine(config, auth, `/api/v1/runs/${encodeURIComponent(runId)}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(response.status === 403 || response.status === 401 ? "access_denied" : "engine_unavailable");
  const run = (await response.json()).data as HarnessRun;
  if (run.run_id !== runId || run.owner_subject !== auth.subject) throw new Error("access_denied");
  return run;
}

async function saveAssignment(job: Handoff, chat: Conversation) {
  const now = new Date();
  const source = participants(chat).find(member => member.agent_id === job.sourceAgentId);
  await (await getCollection("messages")).updateOne({ conversation_id: job.conversationId, message_id: `handoff-${job._id}-user` }, { $setOnInsert: {
    conversation_id: job.conversationId, message_id: `handoff-${job._id}-user`, role: "user", content: job.message,
    sender_name: source?.name ?? "Agent assignment", owner_id: chat.owner_id, created_at: now, updated_at: now,
    metadata: { agent_id: job.targetAgentId, coordination_handoff_id: job._id, source_agent_id: job.sourceAgentId,
      turn_id: `handoff-${job._id}`, is_final: true, source: "coordination" },
  } }, { upsert: true });
  await (await getCollection("messages")).updateOne({ conversation_id: job.conversationId, message_id: handoffAssistantMessageId(`handoff-${job._id}`) }, { $setOnInsert: {
    conversation_id: job.conversationId, message_id: handoffAssistantMessageId(`handoff-${job._id}`), role: "assistant", content: "",
    owner_id: chat.owner_id, created_at: new Date(now.getTime() + 1), updated_at: now,
    metadata: { agent_id: job.targetAgentId, agent_name: `@${job.handle}`, coordination_handoff_id: job._id,
      turn_id: `handoff-${job._id}`, is_final: false, source: "coordination" },
  } }, { upsert: true });

}

async function saveResult(job: Handoff, auth: AuthResult, run: HarnessRun) {
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) throw new Error("engine_unavailable");
  let cursor = 0, content = "";
  // Read the durable authoritative journal; never infer completion from an SSE disconnect.
  while (cursor < run.last_sequence) {
    const response = await proxyHarnessEngine(config, auth, `/api/v1/runs/${encodeURIComponent(run.run_id)}/events?after=${cursor}&wait=0`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("engine_unavailable");
    const page = (await response.json()).data as { events: HarnessRunEvent[]; next_cursor: number };
    for (const event of page.events) {
      if (event.event_type === "content.delta") content += String(event.data.text ?? event.data.delta ?? "");
      if (event.event_type === "result.updated") content = String(event.data.content ?? "");
    }
    if (page.next_cursor <= cursor) throw new Error("journal_incomplete");
    cursor = page.next_cursor;
  }
  const now = new Date();
  await (await getCollection("messages")).updateOne({ conversation_id: job.conversationId, message_id: `handoff-${job._id}-assistant` }, { $set: {
    content: content || (run.status === "completed" ? "Assignment completed." : "Assignment did not complete."), updated_at: now,
    metadata: { agent_id: job.targetAgentId, agent_name: `@${job.handle}`, coordination_handoff_id: job._id,
      harness_run_id: run.run_id, turn_id: `handoff-${job._id}`, is_final: true, turn_status: run.status === "completed" ? "done" : "interrupted", source: "coordination" },
  }, $setOnInsert: { conversation_id: job.conversationId, message_id: `handoff-${job._id}-assistant`, role: "assistant", created_at: now } }, { upsert: true });
  await (await getCollection<Conversation>("conversations")).updateOne({ _id: job.conversationId }, { $set: { updated_at: now } });
}

export async function runHandoffsOnce(): Promise<void> {
  const collection = await jobs();
  await collection.updateMany({ status: { $in: ["pending", "processing"] }, expiresAt: { $lte: new Date() } }, { $set: { status: "failed", lastError: "sign_in_required", updatedAt: new Date() } });
  const candidates = await collection.find(dueDelivery()).sort({ createdAt: 1 }).limit(10).toArray();
  for (const candidate of candidates) {
    const lease = deliveryLease();
    const job = await collection.findOneAndUpdate({ _id: candidate._id, ...dueDelivery() }, lease, { returnDocument: "after" });
    if (!job) continue;
    const fence = { _id: job._id, leaseToken: lease.$set.leaseToken };
    let status: Handoff["status"] = "pending", error: string | undefined;
    try {
      if (!job.runId && !(await getCoordinationFeatures()).team) throw new Error("coordination_disabled");
      const policy = await coordinationPolicy(job.conversationId);
      if (!policy || policy.generation !== job.generation || policy.mode !== "team" || policy.owner !== job.owner || policy.expiresAt <= new Date()) throw new Error("coordination_disabled");
      const auth = await executionAuth(policy);
      const access = await authorizeConversationWriteAccess(auth, job.conversationId, job.targetAgentId);
      if (access.denial || !conversationHasAgent(access.conversation, job.sourceAgentId)) throw new Error("access_denied");
      for (const agentId of [job.sourceAgentId, job.targetAgentId]) {
        if (await requireAgentUsePermission({ ...auth, agentId })) throw new Error("access_denied");
      }
      const parent = await readRun(auth, job.parentRunId);
      if (parent.conversation_id !== job.conversationId || parent.agent_id !== job.sourceAgentId) throw new Error("access_denied");
      if (["failed", "cancelled"].includes(parent.status) || parent.cancellation_requested) status = "skipped";
      else if (parent.status === "completed") {
        if (!job.runId) {
          if (!(await getCoordinationFeatures()).team) throw new Error("coordination_disabled");
          const target = await resolveHarnessGatewayTarget(job.targetAgentId, { subject: auth.subject!, conversationId: job.conversationId, requireEngine: true });
          if (target instanceof NextResponse || target.kind !== "harness_engine") throw new Error("engine_unavailable");
          await saveAssignment(job, access.conversation);
          const started = await startHarnessGatewayRun({ agent_id: job.targetAgentId, conversation_id: job.conversationId,
            message: job.message, client_request_id: `handoff-${job._id}`, turn_id: `handoff-${job._id}` }, auth, target.harnessId);
          if (started instanceof NextResponse) {
            if ([401, 403].includes(started.status)) throw new Error("access_denied");
            throw new Error("admission_unconfirmed");
          }
          job.runId = started.run.run_id;
          await collection.updateOne(fence, { $set: { runId: job.runId } });
        }
        const run = await readRun(auth, job.runId);
        if (run.conversation_id !== job.conversationId || run.agent_id !== job.targetAgentId) throw new Error("access_denied");
        if (["completed", "failed", "cancelled"].includes(run.status)) {
          await saveResult(job, auth, run);
          status = run.status === "completed" ? "delivered" : "failed";
          if (status === "failed") error = run.status === "cancelled" ? "stopped" : "agent_failed";
        }
      }
    } catch (cause) {
      const code = cause instanceof SessionExpiredError ? "sign_in_required" : cause instanceof Error ? cause.message : "unavailable";
      if (["sign_in_required", "access_denied", "coordination_disabled"].includes(code)) { status = "failed"; error = code; }
      else if (job.attempts >= 720) { status = "failed"; error = "recovery_required"; }
      else error = "retrying";
      // Credentials, prompts and raw provider errors never enter diagnostics.
    }
    await collection.updateOne(fence, { $set: { status, updatedAt: new Date(), availableAt: new Date(Date.now() + 3000), ...(error && { lastError: error }) }, $unset: { leaseToken: "", leaseUntil: "", ...(!error && { lastError: "" }) } });
  }

}

export async function listHandoffs(conversationId: string) {
  return (await jobs()).find({ conversationId }, { projection: { _id: 1, handle: 1, status: 1, lastError: 1, runId: 1, targetAgentId: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(20).toArray();
}

export function startHandoffs(): void {
  if (!isMongoDBConfigured) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runHandoffsOnce(); } catch { console.error("[coordination] Delivery queue unavailable"); }
    finally { running = false; }
  };
  const timer = setInterval(() => void tick(), 3000); timer.unref();
}
