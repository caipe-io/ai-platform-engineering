import { getCoordinationFeatures } from "@/lib/coordination/features.server";
import { getAgentId } from "@/types/a2a";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { AuthResult } from "@/lib/da-proxy";
import { buildHarnessEngineHeaders, getHarnessEngineConfig, harnessConversationReadHeaders } from "@/lib/harness-engine-proxy";
import { getCollection } from "@/lib/mongodb";
import type { Conversation } from "@/types/mongodb";
import type { HarnessRun } from "@/types/harness-engine";

interface Admission {
  _id: string;
  generation: string;
  agent_id: string;
  owner_subject: string;
  request_id: string;
  run_id?: string;
  /** Previous fence is held only in this request, never nested in storage. */
  previous?: Admission;
}

/** One admitted turn per coordinated chat, across agents, users and BFF replicas.
 * A subscriber disconnect never releases execution ownership. Uncertain
 * admissions fail closed; only an authoritative terminal run releases the fence.
 */
export async function reserveCoordinationTurn(body: Record<string, unknown>, auth: AuthResult): Promise<Admission | NextResponse | null> {
  const conversation = await (await getCollection<Conversation>("conversations")).findOne({ _id: String(body.conversation_id) });
  if (!conversation?.coordination_agents?.length) return null;
  if (body.agent_id !== getAgentId(conversation) && body.command !== "resume" && !(await getCoordinationFeatures()).enabled) {
    return NextResponse.json({ error: "Agent Coordination is disabled by the administrator" }, { status: 403 });
  }
  const collection = await getCollection<Admission>("chat_coordination_admissions");
  const key = String(body.conversation_id);
  const previous = await collection.findOne({ _id: key });
  if (previous) {
    if (previous.agent_id === body.agent_id && previous.owner_subject === auth.subject && previous.request_id === body.client_request_id) return previous;
    if (!previous.run_id) return NextResponse.json({ error: "The previous turn's admission is still unconfirmed. Retry its original request before starting another turn." }, { status: 409 });
    const config = getHarnessEngineConfig();
    if (config instanceof NextResponse) return config;
    const headers = buildHarnessEngineHeaders(config, auth);
    if (headers instanceof NextResponse) return headers;
    let response: Response;
    try {
      response = await fetch(`${config.url}/api/v1/runs/${encodeURIComponent(previous.run_id)}`, {
        headers: { ...headers, ...harnessConversationReadHeaders({ conversationId: key, agentId: previous.agent_id }) },
        cache: "no-store", signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      console.warn("[chat-coordination] Could not verify the previous turn", error);
      return NextResponse.json({ error: "Could not verify whether the previous turn finished. Try again shortly." }, { status: 503 });
    }
    const envelope = await response.json().catch(() => null);
    const run = envelope?.data;
    if (!response.ok || run?.run_id !== previous.run_id || run?.conversation_id !== key || run?.agent_id !== previous.agent_id) {
      return NextResponse.json({ error: "Could not verify the previous chat turn" }, { status: 503 });
    }
    const resuming = body.command === "resume" && run.status === "paused" && previous.agent_id === body.agent_id && previous.owner_subject === auth.subject;
    if (!resuming && !["completed", "failed", "cancelled"].includes(run.status)) {
      return NextResponse.json({ error: "Another agent is responding or waiting for input in this chat. Finish or stop that turn first." }, { status: 409 });
    }
  }
  const ticket: Admission = { _id: key, generation: randomUUID(), agent_id: String(body.agent_id), owner_subject: auth.subject,
    request_id: typeof body.client_request_id === "string" ? body.client_request_id : randomUUID() };
  // Use the same request identity at the Engine and the fence, including resumes.
  body.client_request_id = ticket.request_id;
  if (previous) {
    const result = await collection.replaceOne({ _id: key, generation: previous.generation }, ticket);
    if (!result.modifiedCount) return NextResponse.json({ error: "Another turn was admitted. Check the chat before sending again." }, { status: 409 });
  } else {
    try { await collection.insertOne(ticket); }
    catch (error) {
      if ((error as { code?: number }).code === 11000) return NextResponse.json({ error: "Another turn was admitted. Check the chat before sending again." }, { status: 409 });
      throw error;
    }
  }
  return { ...ticket, ...(previous && { previous }) };
}

export async function recordCoordinationRun(ticket: Admission | null, run: HarnessRun): Promise<void> {
  if (!ticket) return;
  await (await getCollection<Admission>("chat_coordination_admissions")).updateOne(
    { _id: ticket._id, generation: ticket.generation }, { $set: { run_id: run.run_id } },
  );
}

/** Status replay can repair a lost admission acknowledgement without re-running a prompt. */
export async function reconcileCoordinationRun(run: HarnessRun | null | undefined): Promise<void> {
  if (!run?.client_request_id) return;
  await (await getCollection<Admission>("chat_coordination_admissions")).updateOne({
    _id: run.conversation_id, agent_id: run.agent_id, owner_subject: run.owner_subject,
    request_id: run.client_request_id, run_id: { $exists: false },
  }, { $set: { run_id: run.run_id } });
}

/** Clear only a definite rejection, never a timeout or unavailable response. */
export async function rejectCoordinationTurn(ticket: Admission | null): Promise<void> {
  if (!ticket || ticket.run_id) return;
  const collection = await getCollection<Admission>("chat_coordination_admissions");
  const key = { _id: ticket._id, generation: ticket.generation, run_id: { $exists: false } };
  // A rejected resume must retain the original paused run's ownership.
  if (ticket.previous) await collection.replaceOne(key, ticket.previous);
  else await collection.deleteOne(key);
}
