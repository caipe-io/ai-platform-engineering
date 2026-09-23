/**
 * Server-side API route for submitting user feedback.
 *
 * Single entry-point for ALL feedback (web UI + Slack). Every submission:
 *   1. Writes to the unified `feedback` MongoDB collection (always)
 *   2. Sends scores to Langfuse (when configured)
 *
 * @see https://langfuse.com/docs/observability/features/user-feedback
 */

import { ApiError,getAuthFromBearerOrSession } from "@/lib/api-middleware";
import { getCollection,isMongoDBConfigured } from "@/lib/mongodb";
import { Langfuse } from "langfuse";
import { NextRequest,NextResponse } from "next/server";

// Langfuse configuration from environment variables (server-side only)
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY;
const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY;
const LANGFUSE_HOST = process.env.LANGFUSE_HOST;

// Check if Langfuse is configured
const isLangfuseConfigured = (): boolean => {
  return !!(LANGFUSE_SECRET_KEY && LANGFUSE_PUBLIC_KEY && LANGFUSE_HOST);
};

// Singleton Langfuse client instance
let langfuseClient: Langfuse | null = null;

const getLangfuseClient = (): Langfuse | null => {
  if (!isLangfuseConfigured()) {
    return null;
  }

  if (!langfuseClient) {
    langfuseClient = new Langfuse({
      secretKey: LANGFUSE_SECRET_KEY!,
      publicKey: LANGFUSE_PUBLIC_KEY!,
      baseUrl: LANGFUSE_HOST!,
    });
  }

  return langfuseClient;
};

// Valid feedback values (superset of web + Slack)
const VALID_FEEDBACK_VALUES = [
  "thumbs_up", "thumbs_down",
  "wrong_answer", "needs_detail", "too_verbose", "retry", "other",
];

// Request body interface
interface FeedbackRequest {
  traceId?: string;
  messageId?: string;
  feedbackType: "like" | "dislike";
  /** Granular feedback value. Defaults to thumbs_up/thumbs_down from feedbackType. */
  value?: string;
  reason?: string;
  additionalFeedback?: string;
  conversationId?: string;
  /** Source client: "web" (default) or "slack" */
  source?: "web" | "slack";
  // Slack-specific context (optional)
  channelId?: string;
  channelName?: string;
  threadTs?: string;
  slackPermalink?: string;
  userId?: string;
  /** Caller-provided email (e.g. resolved from Slack user profile) */
  userEmail?: string;
}

// Response interface
interface FeedbackResponse {
  success: boolean;
  message: string;
  langfuseEnabled?: boolean;
}

/**
 * POST /api/feedback
 * Submit user feedback for a message — writes to MongoDB + Langfuse
 */
export async function POST(request: NextRequest): Promise<NextResponse<FeedbackResponse>> {
  try {
    const { user } = await getAuthFromBearerOrSession(request);
    const body: FeedbackRequest = await request.json();
    const userEmail = user.email;

    // Validate required fields
    if (!body.conversationId && !body.traceId && !body.messageId) {
      return NextResponse.json(
        { success: false, message: "conversationId, traceId, or messageId is required" },
        { status: 400 }
      );
    }

    if (!body.feedbackType || !["like", "dislike"].includes(body.feedbackType)) {
      return NextResponse.json(
        { success: false, message: "feedbackType must be 'like' or 'dislike'" },
        { status: 400 }
      );
    }

    const source = body.source || "web";
    const rating = body.feedbackType === "like" ? "positive" : "negative";
    // Granular value: use explicit value if valid, else derive from feedbackType
    const scoreValue =
      body.value && VALID_FEEDBACK_VALUES.includes(body.value)
        ? body.value
        : body.feedbackType === "like" ? "thumbs_up" : "thumbs_down";

    // Combine reason + additional feedback into a single comment
    const commentParts: string[] = [];
    if (body.reason) commentParts.push(body.reason);
    if (body.additionalFeedback) commentParts.push(body.additionalFeedback);
    const comment = commentParts.length > 0 ? commentParts.join(": ") : null;

    // Priority for Langfuse traceId: conversationId > traceId > messageId
    const langfuseTraceId = body.conversationId || body.traceId || body.messageId;

    console.log("[Feedback API] Received feedback:", {
      langfuseTraceId,
      messageId: body.messageId,
      feedbackType: body.feedbackType,
      value: scoreValue,
      source,
      reason: body.reason,
      userEmail,
      conversationId: body.conversationId,
      timestamp: new Date().toISOString(),
    });

    // ── 1. Write to MongoDB feedback collection ─────────────────────
    if (isMongoDBConfigured) {
      try {
        const feedbackColl = await getCollection("feedback");
        const now = new Date();

        // For Slack: upsert on (messageId, userId, source) so refinement
        // actions update the initial thumbs_down rather than duplicating,
        // while still allowing different users (or the same user on different
        // bot replies in the same thread) to each have their own feedback doc.
        if (source === "slack" && body.threadTs && body.userId) {
          await feedbackColl.updateOne(
            {
              message_id: body.messageId || body.threadTs,
              user_id: body.userId,
              source: "slack",
            },
            {
              $set: {
                trace_id: body.traceId || null,
                rating,
                value: scoreValue,
                comment,
                user_email: userEmail !== "anonymous" ? userEmail : null,
                conversation_id: body.conversationId || `slack-${body.threadTs}`,
                channel_id: body.channelId || null,
                channel_name: body.channelName || null,
                thread_ts: body.threadTs,
                slack_permalink: body.slackPermalink || null,
                updated_at: now,
              },
              $setOnInsert: {
                created_at: now,
              },
            },
            { upsert: true },
          );
        } else {
          await feedbackColl.insertOne({
            trace_id: body.traceId || null,
            source,
            rating,
            value: scoreValue,
            comment,
            user_email: userEmail,
            user_id: body.userId || null,
            message_id: body.messageId || null,
            conversation_id: body.conversationId || null,
            channel_id: null,
            channel_name: null,
            thread_ts: null,
            slack_permalink: null,
            created_at: now,
          });
        }
      } catch (err) {
        console.warn("[Feedback API] Failed to write to MongoDB feedback collection:", err);
      }
    }

    // ── 2. Send to Langfuse ─────────────────────────────────────────
    const langfuse = getLangfuseClient();
    let langfuseEnabled = false;

    if (langfuse && langfuseTraceId) {
      const metadata: Record<string, string> = {
        user_email: userEmail,
        source,
      };
      if (body.messageId) metadata.message_id = body.messageId;
      if (body.conversationId) metadata.session_id = body.conversationId;

      // Score 1: Source-specific score ("all web" or channel-specific for Slack)
      const sourceScopeName = source === "slack"
        ? (body.channelName || "all slack channels")
        : "all web";
      langfuse.score({
        traceId: langfuseTraceId,
        name: sourceScopeName,
        value: scoreValue,
        dataType: "CATEGORICAL",
        comment: comment || undefined,
        metadata,
      });

      // Score 2 (Slack only): Aggregated score for all Slack channels
      if (source === "slack" && sourceScopeName !== "all slack channels") {
        langfuse.score({
          traceId: langfuseTraceId,
          name: "all slack channels",
          value: scoreValue,
          dataType: "CATEGORICAL",
          comment: comment || undefined,
          metadata,
        });
      }

      // Score 3: Aggregated score across all clients (Slack + Web)
      langfuse.score({
        traceId: langfuseTraceId,
        name: "all",
        value: scoreValue,
        dataType: "CATEGORICAL",
        comment: comment || undefined,
        metadata,
      });

      try {
        await langfuse.flushAsync();
        langfuseEnabled = true;
        console.log("[Feedback API] Feedback sent to Langfuse:", {
          traceId: langfuseTraceId,
          scoreValue,
          comment,
        });
      } catch (flushErr) {
        console.error("[Feedback API] Langfuse flush failed:", flushErr);
        // langfuseEnabled stays false — caller sees the failure
      }
    }

    return NextResponse.json({
      success: true,
      message: "Feedback submitted successfully",
      langfuseEnabled,
    });
  } catch (error) {
    console.error("[Feedback API] Error processing feedback:", error);

    return NextResponse.json(
      {
        success: false,
        message: error instanceof Error ? error.message : "Failed to submit feedback",
      },
      { status: error instanceof ApiError ? error.statusCode : 500 }
    );
  }
}

/**
 * GET /api/feedback
 * Check if Langfuse feedback is enabled
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    enabled: isLangfuseConfigured(),
    host: LANGFUSE_HOST ? new URL(LANGFUSE_HOST).hostname : null,
  });
}
