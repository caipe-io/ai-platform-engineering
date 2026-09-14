/**
 * Turns API — per-turn persistence decoupled from the messages collection.
 *
 * GET  /api/chat/conversations/[id]/turns?client_type=ui
 *   → Fetch all turns for a conversation filtered by client_type.
 *     Returns turns sorted by created_at ascending.
 *
 * POST /api/chat/conversations/[id]/turns
 *   → Upsert a turn document. Keyed on (conversation_id, client_type, turn_id).
 *     The payload is opaque — the server stores it as-is.
 *
 * The web UI stores collapsed stream_events + message metadata in the payload.
 * The Slack bot stores thread mapping info. Future clients store their own shape.
 */

import {
ApiError,
getPaginationParams,
paginatedResponse,
requireConversationAccess,
successResponse,
validateRequired,
validateConversationId,
withAuth,
withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import type { Conversation,Turn,UpsertTurnRequest } from "@/types/mongodb";
import { NextRequest } from "next/server";

// ─── GET /api/chat/conversations/[id]/turns ──────────────────────────────────

export const GET = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    return withAuth(request, async (req, user, session) => {
      const { id: conversationId } = await context.params;

      if (!validateConversationId(conversationId)) {
        throw new ApiError("Invalid conversation ID format", 400);
      }

      // Verify user has access
      await requireConversationAccess(
        conversationId,
        user.email,
        getCollection,
        session,
      );
      await requireResourcePermission(session, {
        type: "conversation",
        id: conversationId,
        action: "read",
      });

      const { searchParams } = new URL(request.url);
      const clientType = searchParams.get("client_type") || "ui";
      const { page, pageSize, skip } = getPaginationParams(request);

      const turns = await getCollection<Turn>("turns");

      const filter = { conversation_id: conversationId, client_type: clientType };
      const total = await turns.countDocuments(filter);

      const items = await turns
        .find(filter)
        .sort({ created_at: 1 })
        .skip(skip)
        .limit(pageSize)
        .toArray();

      return paginatedResponse(items, total, page, pageSize);
    });
  },
);

// ─── POST /api/chat/conversations/[id]/turns ─────────────────────────────────

export const POST = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    return withAuth(request, async (req, user, session) => {
      const { id: conversationId } = await context.params;
      const body: UpsertTurnRequest = await request.json();

      if (!validateConversationId(conversationId)) {
        throw new ApiError("Invalid conversation ID format", 400);
      }

      validateRequired(body, ["turn_id", "client_type", "payload"]);

      // Verify user has write access
      const { access_level } = await requireConversationAccess(
        conversationId,
        user.email,
        getCollection,
        session,
      );
      await requireResourcePermission(session, {
        type: "conversation",
        id: conversationId,
        action: "write",
      });

      if (access_level === "admin_audit" || access_level === "shared_readonly") {
        throw new ApiError(
          "Read-only access — cannot write turns",
          403,
          "FORBIDDEN",
        );
      }

      const turns = await getCollection<Turn>("turns");
      const now = new Date();

      // Upsert: keyed on (conversation_id, client_type, turn_id)
      const result = await turns.updateOne(
        {
          conversation_id: conversationId,
          client_type: body.client_type,
          turn_id: body.turn_id,
        },
        {
          $set: {
            payload: body.payload,
            updated_at: now,
          },
          $setOnInsert: {
            conversation_id: conversationId,
            client_type: body.client_type,
            turn_id: body.turn_id,
            created_at: now,
          },
        },
        { upsert: true },
      );

      // Touch the conversation updated_at
      const conversations = await getCollection<Conversation>("conversations");
      await conversations.updateOne(
        { _id: conversationId },
        { $set: { updated_at: now } },
      );

      const upserted = await turns.findOne({
        conversation_id: conversationId,
        client_type: body.client_type,
        turn_id: body.turn_id,
      });

      return successResponse(upserted, result.upsertedId ? 201 : 200);
    });
  },
);
