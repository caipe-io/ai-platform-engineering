import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authorizeConversationWriteAccess, resolveConversationRuntimeId } from "@/app/api/v1/chat/_conversation-authz";
import { authenticateRequest } from "@/lib/da-proxy";
import { gatewayBindingId, invokeHarnessGatewayRun, resolveHarnessGatewayTarget } from "@/lib/harness-gateway";
import { getHarnessEngineConfig, lookupHarnessSession } from "@/lib/harness-engine-proxy";
import { getCollection } from "@/lib/mongodb";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";

/** Explicit, quiescent native handoff. No checkpoint copy or deletion. */
export async function POST(request: NextRequest): Promise<Response> {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;
  const body = await request.json().catch(() => null);
  if (!body || typeof body.agent_id !== "string" || typeof body.conversation_id !== "string" || !["adopt", "rollback"].includes(body.action)) {
    return NextResponse.json({ error: "agent_id, conversation_id and adopt/rollback action are required" }, { status: 400 });
  }
  const denied = await requireAgentUsePermission({ subject: auth.subject, email: auth.email, agentId: body.agent_id, isServiceAccount: auth.isServiceAccount });
  if (denied) return denied;
  const access = await authorizeConversationWriteAccess(auth, body.conversation_id, body.agent_id);
  if (access.denial) return access.denial;
  const conversationId = await resolveConversationRuntimeId(access.conversation);
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) return config;
  const bindings = await getCollection<{ _id: string; runtime?: string; transition_id?: string; transition_action?: string; native_thread_id?: string }>("harness_gateway_bindings");
  const key = { _id: gatewayBindingId(body.agent_id, auth.subject, conversationId) };
  let claimed = await bindings.findOne(key);
  if (!claimed?.transition_id) {
    const target = await resolveHarnessGatewayTarget(body.agent_id, { subject: auth.subject, conversationId });
    if (target instanceof NextResponse) return target;
    if (target.harnessId !== "dynamic_agents") return NextResponse.json({ error: "Only native Deep Agents sessions can be handed off" }, { status: 409 });
    const before = await lookupHarnessSession(config, auth, body.agent_id, conversationId);
    if (before instanceof NextResponse) return before;
    if (before.active_run) return NextResponse.json({ error: "Stop the active run before handing off its session" }, { status: 409 });
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
  await bindings.updateOne({ ...key, transition_id: transition }, { $set: {
    runtime: body.action === "adopt" ? "harness_engine" : "dynamic_agents", native_thread_id: saved.native_thread_id,
  }, $unset: { transition_id: "", transition_action: "" } });
  return NextResponse.json({ success: true, data: { runtime: body.action === "adopt" ? "harness_engine" : "dynamic_agents", native_thread_id: saved.native_thread_id, pending_interrupt: saved.pending_interrupt } });
}
