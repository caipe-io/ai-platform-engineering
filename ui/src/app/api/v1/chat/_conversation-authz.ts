import { NextResponse } from "next/server";

import { getCollection } from "@/lib/mongodb";
import { requireConversationResourcePermission } from "@/lib/rbac/conversation-implicit-authz";
import type { Conversation } from "@/types/mongodb";

import type { AuthResult } from "./_helpers";

interface AutonomousRunContext {
  task_id: string;
  execution_context_id?: string | null;
  started_at?: Date | string;
}

export type ConversationWriteAuthorization =
  | { conversation: Conversation; denial: null }
  | { conversation: Conversation | null; denial: NextResponse };

export async function authorizeConversationWriteAccess(
  authResult: AuthResult,
  conversationId: string,
): Promise<ConversationWriteAuthorization> {
  const conversations = await getCollection<Conversation>("conversations");
  const conversation = await conversations.findOne({ _id: conversationId });
  if (!conversation) {
    return {
      conversation: null,
      denial: NextResponse.json(
        {
          success: false,
          error: "Conversation not found",
          code: "conversation#write",
        },
        { status: 404 },
      ),
    };
  }

  // Slack threads are inherently multi-participant — anyone in the channel
  // should be able to invoke the agent within a thread, not just the user who
  // originally @mentioned the bot. Rather than granting wildcard writer tuples
  // (which would also leak read access via the model's `can_read: ... or
  // can_write` rule), we bypass the conversation#write check for Slack
  // conversations here.
  //
  // Safe because:
  //   - agent#can_use is enforced first and independently on every invoke/stream
  //     route, so this grants no tool/data/agent access.
  //   - `client_type` is read from the stored document, never the request body,
  //     so a caller cannot spoof it; no update path lets it be flipped to 'slack'.
  //   - Read endpoints (GET messages/turns/detail) still require `can_read`,
  //     which this does not touch — thread history stays ReBAC-protected.
  //   - Metadata mutation is separately gated (owner-only), so routing keys
  //     cannot be injected via this path.
  if (conversation.client_type === "slack") {
    return { conversation, denial: null };
  }

  try {
    await requireConversationResourcePermission(
      // Carry isServiceAccount so subjectFromSession graphs SA callers as
      // `service_account:<sub>` (not `user:<sub>`). Without this, a Slack route
      // running as a service account fails conversation#write even though the
      // SA holds the writer grant on the conversation it created.
      { sub: authResult.subject, user: { email: authResult.email }, isServiceAccount: authResult.isServiceAccount },
      authResult.email ?? "",
      conversation,
      "write",
    );
    return { conversation, denial: null };
  } catch (error) {
    return {
      conversation,
      denial: NextResponse.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Access denied",
          code: (error as { code?: string }).code,
        },
        { status: (error as { statusCode?: number }).statusCode ?? 500 },
      ),
    };
  }
}

/**
 * Resolve the server-owned Dynamic Agents context behind a visible chat.
 *
 * Autonomous cron/interval runs deliberately get isolated checkpointer IDs,
 * while their messages are grouped into one stable task conversation. For an
 * interactive reply, authorize against that visible conversation and then use
 * the latest run context only for the Dynamic Agents request.
 */
export async function resolveConversationRuntimeId(
  conversation: Conversation,
): Promise<string> {
  if (conversation.source !== "autonomous") return conversation._id;

  if (
    typeof conversation.execution_context_id === "string" &&
    conversation.execution_context_id.trim()
  ) {
    return conversation.execution_context_id;
  }

  const taskId =
    typeof conversation.task_id === "string"
      ? conversation.task_id
      : typeof conversation.metadata?.task_id === "string"
        ? conversation.metadata.task_id
        : null;
  if (!taskId) return conversation._id;

  // Backward compatibility for conversations published before the pointer was
  // added. Both services use the same Mongo database by deployment contract.
  const runsCollectionName =
    process.env.AUTONOMOUS_RUNS_COLLECTION || "autonomous_runs";
  const runs = await getCollection<AutonomousRunContext>(runsCollectionName);
  const latest = await runs.findOne(
    { task_id: taskId, execution_context_id: { $ne: null } },
    { sort: { started_at: -1 } },
  );
  const runtimeId = latest?.execution_context_id;
  if (typeof runtimeId !== "string" || !runtimeId.trim()) {
    return conversation._id;
  }

  // Best-effort self-heal so the legacy lookup is paid only once. A cache
  // write failure must not block the follow-up we already resolved.
  try {
    const conversations = await getCollection<Conversation>("conversations");
    await conversations.updateOne(
      { _id: conversation._id, source: "autonomous" },
      { $set: { execution_context_id: runtimeId } },
    );
  } catch (error) {
    console.warn(
      `[chat] Could not cache autonomous runtime context for ${conversation._id}:`,
      error,
    );
  }
  return runtimeId;
}
