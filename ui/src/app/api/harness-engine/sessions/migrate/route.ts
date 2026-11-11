import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authorizeConversationWriteAccess, resolveConversationRuntimeId } from "@/app/api/v1/chat/_conversation-authz";
import { authenticateRequest } from "@/lib/da-proxy";
import { gatewayBindingId, invokeHarnessGatewayRun, resolveHarnessGatewayTarget } from "@/lib/harness-gateway";
import { getHarnessEngineConfig, lookupHarnessSession } from "@/lib/harness-engine-proxy";
import { getCollection } from "@/lib/mongodb";
import { findAgenticAppAssistantStream } from "@/lib/agentic-apps/assistant-stream";
import type { HarnessSessionMigrationStatus } from "@/types/harness-session-migration";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";

export const runtime = "nodejs";
export const maxDuration = 300;

interface NativeAgent {
  _id: string;
  enabled?: boolean;
  execution_harness_id?: string;
  backend?: { config?: { checkpoint_collection?: string | null } };
}

interface MigrationBinding {
  _id: string;
  harness_id?: string;
  runtime?: string;
  transition_id?: string;
  transition_action?: string;
  native_thread_id?: string;
}

function migrationStatus(state: HarnessSessionMigrationStatus["state"]): NextResponse {
  return NextResponse.json({ success: true, data: { state } }, { headers: { "Cache-Control": "no-store" } });
}

async function nativeThreadBusy(agent: NativeAgent, threadId: string): Promise<boolean> {
  const collection = agent.backend?.config?.checkpoint_collection || process.env.CHECKPOINT_COLLECTION || "checkpoints_conversation";
  const key = createHash("sha256").update(`${collection}\0${threadId}`).digest("hex");
  const lease = await (await getCollection<{ _id: string; active_run?: string | null }>("execution_thread_leases")).findOne({ _id: key });
  return Boolean(lease?.active_run);
}

/** Inspect eligibility without creating bindings, runs, or native sessions. */
export async function GET(request: NextRequest): Promise<Response> {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;
  if (!auth.subject) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const agentId = request.nextUrl.searchParams.get("agent_id");
  const conversationId = request.nextUrl.searchParams.get("conversation_id");
  if (!agentId?.trim() || !conversationId?.trim()) return NextResponse.json({ error: "agent_id and conversation_id are required" }, { status: 400 });
  const denied = await requireAgentUsePermission({ subject: auth.subject, email: auth.email, tenantId: auth.tenantId, agentId, isServiceAccount: auth.isServiceAccount });
  if (denied) return denied;
  const access = await authorizeConversationWriteAccess(auth, conversationId, agentId);
  if (access.denial) return access.denial;
  if (findAgenticAppAssistantStream(agentId)) return migrationStatus("unavailable");
  const runtimeId = await resolveConversationRuntimeId(access.conversation);
  const binding = await (await getCollection<MigrationBinding>("harness_gateway_bindings")).findOne({ _id: gatewayBindingId(agentId, auth.subject, runtimeId) });
  if (!binding?.transition_id && process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED !== "true") return migrationStatus("unavailable");
  const agent = await (await getCollection<NativeAgent>("dynamic_agents")).findOne({ _id: agentId });
  if (!agent || agent.enabled === false || (agent.execution_harness_id || "dynamic_agents") !== "dynamic_agents" ||
      (binding?.harness_id && binding.harness_id !== "dynamic_agents")) return migrationStatus("unavailable");
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) return config;
  if (binding?.transition_id) return migrationStatus(binding.transition_action === "adopt" ? "recoverable" : "unavailable");
  const saved = await lookupHarnessSession(config, auth, agentId, runtimeId);
  if (saved instanceof NextResponse) return saved;
  if (saved.harness_id && saved.harness_id !== "dynamic_agents") return migrationStatus("unavailable");
  if (binding?.runtime === "harness_engine" || (!binding && saved.harness_id === "dynamic_agents")) return migrationStatus("managed");
  if (saved.active_run || await nativeThreadBusy(agent, binding?.native_thread_id || saved.native_thread_id || runtimeId)) return migrationStatus("busy");
  // A fresh chat with no native checkpoint will already use Engine on first send.
  if (!binding) {
    const collection = agent.backend?.config?.checkpoint_collection || process.env.CHECKPOINT_COLLECTION || "checkpoints_conversation";
    const checkpoint = await (await getCollection(collection)).findOne({ thread_id: runtimeId }, { projection: { _id: 1 } });
    if (!checkpoint) return migrationStatus("unavailable");
  }
  return migrationStatus("available");
}

/** Explicit, quiescent native handoff. No checkpoint copy or deletion. */
export async function POST(request: NextRequest): Promise<Response> {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;
  if (!auth.subject) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body.agent_id !== "string" || !body.agent_id.trim() || typeof body.conversation_id !== "string" || !body.conversation_id.trim() || !["adopt", "rollback"].includes(body.action)) {
    return NextResponse.json({ error: "agent_id, conversation_id and adopt/rollback action are required" }, { status: 400 });
  }
  const denied = await requireAgentUsePermission({ subject: auth.subject, email: auth.email, tenantId: auth.tenantId, agentId: body.agent_id, isServiceAccount: auth.isServiceAccount });
  if (denied) return denied;
  const access = await authorizeConversationWriteAccess(auth, body.conversation_id, body.agent_id);
  if (access.denial) return access.denial;
  const conversationId = await resolveConversationRuntimeId(access.conversation);
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) return config;
  const bindings = await getCollection<MigrationBinding>("harness_gateway_bindings");
  const key = { _id: gatewayBindingId(body.agent_id, auth.subject, conversationId) };
  let claimed = await bindings.findOne(key);
  if (!claimed?.transition_id) {
    const target = await resolveHarnessGatewayTarget(body.agent_id, { subject: auth.subject, conversationId });
    if (target instanceof NextResponse) return target;
    if (target.harnessId !== "dynamic_agents") return NextResponse.json({ error: "Only native Deep Agents sessions can be handed off" }, { status: 409 });
    const before = await lookupHarnessSession(config, auth, body.agent_id, conversationId);
    if (before instanceof NextResponse) return before;
    const agent = await (await getCollection<NativeAgent>("dynamic_agents")).findOne({ _id: body.agent_id });
    if (!agent || agent.enabled === false || (agent.execution_harness_id || "dynamic_agents") !== "dynamic_agents" ||
        (before.harness_id && before.harness_id !== "dynamic_agents")) return NextResponse.json({ error: "Only available Deep Agents conversations can be migrated" }, { status: 409 });
    if (before.active_run || await nativeThreadBusy(agent, claimed?.native_thread_id || before.native_thread_id || conversationId)) return NextResponse.json({ error: "Stop the active run before handing off its session" }, { status: 409 });
    claimed = await bindings.findOneAndUpdate({ ...key, transition_id: { $exists: false } }, {
      $set: { transition_id: randomUUID(), transition_action: body.action },
    }, { returnDocument: "after" });
  }
  if (!claimed?.transition_id || claimed.transition_action !== body.action) return NextResponse.json({ error: "Retry the in-progress handoff with its original action" }, { status: 409 });
  // Repeating the authenticated operation recovers a stopped BFF. The same
  // request key observes the original Engine run and never starts a second one.
  const transition = claimed.transition_id;
  const reconciled = await invokeHarnessGatewayRun({ agent_id: body.agent_id, conversation_id: conversationId, command: "reconcile", handoff_owner: body.action === "adopt" ? "harness_engine" : "dynamic_agents", client_request_id: transition }, auth);
  if (!reconciled.ok) {
    const stopped = await lookupHarnessSession(config, auth, body.agent_id, conversationId);
    if (!(stopped instanceof NextResponse) && !stopped.active_run &&
        stopped.last_run?.client_request_id === transition && ["failed", "cancelled"].includes(stopped.last_run.status)) {
      await bindings.updateOne({ ...key, transition_id: transition }, { $unset: { transition_id: "", transition_action: "" } });
    }
    return reconciled;
  }
  const saved = await lookupHarnessSession(config, auth, body.agent_id, conversationId);
  if (saved instanceof NextResponse) return saved;
  if (!saved.native_thread_id || saved.active_run) return NextResponse.json({ error: "Session reconciliation has not drained" }, { status: 409 });
  const committed = await bindings.updateOne({ ...key, transition_id: transition }, { $set: {
    runtime: body.action === "adopt" ? "harness_engine" : "dynamic_agents", native_thread_id: saved.native_thread_id,
  }, $unset: { transition_id: "", transition_action: "" } });
  if (committed.matchedCount !== 1) return NextResponse.json({ error: "Session handoff changed; retry to recover its current state" }, { status: 409 });
  return NextResponse.json({ success: true, data: { runtime: body.action === "adopt" ? "harness_engine" : "dynamic_agents", native_thread_id: saved.native_thread_id, pending_interrupt: saved.pending_interrupt } });
}
