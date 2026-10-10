/**
 * POST /api/ai/review
 *
 * Run an admin-configured rubric of small atomic criteria against a piece
 * of content (an agent system prompt, a SKILL.md, etc.). Each criterion is
 * an independent LLM call run in parallel; verdicts are aggregated into a
 * weighted score + letter grade.
 *
 * Response is a single JSON object (no SSE — the user explicitly chose
 * batch since each criterion already streams nothing back from the model
 * other than a tiny verdict).
 *
 * Pipeline:
 *   1. Parse + validate request shape; cap content size at 64KB.
 *   2. Verify the client-computed `content_hash` matches a server-side
 *      sha-256 of the same `content` (defense against tampered cache keys).
 *   3. Authenticate via `authenticateRequest` (forwards 401 directly).
 *   4. Per-user rate limit via `consume` with task id `review-{target}`.
 *   5. Load the review config from Mongo, fall back to seed defaults.
 *   6. If the config is `enabled === false`, return a synthetic "passed"
 *      result so consumer flows aren't blocked while admins are mid-config.
 *   7. Resolve the model: per-config override > Platform LLM >
 *      Mongo `llm_models` first row > registry default.
 *   8. Run all criteria in parallel via Promise.all (runCriterion catches
 *      its own errors and returns a verdict-with-error).
 *   9. Aggregate via computeScoreAndGrade; pass = score >= min_score.
 */

import { authenticateRequest } from "@/lib/da-proxy";
import { consume } from "@/lib/server/ai-assist-rate-limit";
import { ensureConfig } from "@/lib/server/ai-review/defaults";
import { computeScoreAndGrade } from "@/lib/server/ai-review/grading";
import { runCriterion } from "@/lib/server/ai-review/run-criteria";
import { resolveLlmModel } from "@/lib/server/platform-llm.server";
import {
DEFAULT_GRADE_THRESHOLDS,
type CriterionVerdict,
type ReviewConfig,
type ReviewContext,
type ReviewRequest,
type ReviewResult,
} from "@/types/ai-review";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

/** Hard upper bound on input size to avoid pathological prompts. */
const MAX_CONTEXT_BYTES = 64 * 1024;

/** Conservative cap on rubric size — prevents runaway parallel LLM calls. */
const MAX_CRITERIA = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ success: false, error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function userKeyFromUserContext(
  header: string | undefined,
): string | undefined {
  if (!header) return undefined;
  try {
    const json = Buffer.from(header, "base64").toString("utf8");
    const ctx = JSON.parse(json) as { email?: string };
    return ctx.email || undefined;
  } catch {
    return undefined;
  }
}

/** Compute sha-256 hex of `content` server-side for hash verification. */
function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Trivial guard for the 64-char hex shape clients send up. */
function isValidHexHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // ---- Parse + validate ---------------------------------------------------
  let body: ReviewRequest;
  try {
    body = (await request.json()) as ReviewRequest;
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const target = (body.target ?? "").trim();
  if (!target) return jsonError(400, "`target` is required");

  if (typeof body.content !== "string") {
    return jsonError(400, "`content` must be a string");
  }
  const contentBytes = Buffer.byteLength(body.content, "utf8");
  if (contentBytes > MAX_CONTEXT_BYTES) {
    return jsonError(
      413,
      `Content too large (${contentBytes} bytes; max ${MAX_CONTEXT_BYTES})`,
    );
  }

  if (!isValidHexHash(body.content_hash)) {
    return jsonError(400, "`content_hash` must be a 64-char hex string");
  }

  const serverHash = hashContent(body.content);
  if (serverHash !== body.content_hash) {
    return jsonError(
      400,
      "`content_hash` does not match server-computed sha-256 of `content`",
    );
  }

  const context: ReviewContext = body.context ?? {};
  if (JSON.stringify(context).length > MAX_CONTEXT_BYTES) {
    return jsonError(413, "`context` too large");
  }

  // ---- Auth ---------------------------------------------------------------
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth; // 401

  const userKey = userKeyFromUserContext(auth.userContextHeader);

  // ---- Rate limit ---------------------------------------------------------
  const taskId = `review-${target}`;
  const decision = consume(userKey, taskId);
  if (!decision.allowed) {
    return new Response(
      JSON.stringify({
        success: false,
        error: `Rate limit exceeded for "${taskId}". Try again in ${decision.retryAfterSec}s.`,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(decision.retryAfterSec),
          "X-RateLimit-Limit": String(decision.limit),
          "X-RateLimit-Remaining": "0",
        },
      },
    );
  }

  // ---- Load config --------------------------------------------------------
  // ensureConfig upserts defaults on first read so the collection is
  // self-initializing for known targets. Returns null only for unknown
  // targets (which means a misconfigured caller, since the registry is the
  // only source of truth for valid target ids).
  const config: ReviewConfig | null = await ensureConfig(target);
  if (!config) {
    return jsonError(404, `Unknown review target '${target}'`);
  }

  const enforcement = config.enforcement ?? "informational";

  // ---- Disabled? short-circuit a passing result --------------------------
  if (config.enabled === false) {
    const result: ReviewResult & { feature_disabled?: true } = {
      hash: body.content_hash,
      score: 1,
      grade: "A",
      passed: true,
      enforcement,
      criteria: [],
      total: 0,
      passed_count: 0,
      model: { id: "", provider: "" },
      // Surface a flag so consumers can render "review off" instead of
      // pretending the rubric ran.
      feature_disabled: true,
    };
    return new Response(JSON.stringify({ success: true, data: result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ---- Build runner inputs ------------------------------------------------
  const enabledCriteria = (config.criteria ?? []).slice(0, MAX_CRITERIA);
  const model = await resolveLlmModel(config.model);

  // Forward the same auth headers `da-proxy.buildBackendHeaders` would, so
  // each parallel `/api/v1/assistant/suggest` call passes through DA's
  // JwtAuthMiddleware. Forgetting the bearer token here is what produced
  // the "AI Review — 0/N criteria passed: Backend error: Unauthorized"
  // failure mode for signed-in admins; pin all three headers explicitly.
  const headers: Record<string, string> = {};
  if (auth.userContextHeader) {
    headers["X-User-Context"] = auth.userContextHeader;
  }
  if (auth.bearerToken) {
    headers["Authorization"] = `Bearer ${auth.bearerToken}`;
  }
  if (auth.traceparent) {
    headers.traceparent = auth.traceparent;
  }

  // ---- Run all criteria in parallel --------------------------------------
  // runCriterion catches its own errors and returns a verdict-with-error,
  // so plain Promise.all is safe — no need for allSettled.
  const verdicts: CriterionVerdict[] = await Promise.all(
    enabledCriteria.map((criterion) =>
      runCriterion({
        criterion,
        content: body.content,
        context,
        model,
        headers,
      }),
    ),
  );

  // ---- Aggregate ---------------------------------------------------------
  const thresholds = config.grade_thresholds ?? DEFAULT_GRADE_THRESHOLDS;
  const { score, grade, passed_count, total } = computeScoreAndGrade(
    verdicts,
    thresholds,
  );

  const minScore =
    typeof config.min_score === "number" ? config.min_score : 0.85;
  // Honest pass/fail signal regardless of enforcement — consumers decide
  // whether to gate on it based on `enforcement`.
  const passed = score >= minScore;

  const result: ReviewResult = {
    hash: body.content_hash,
    score,
    grade,
    passed,
    enforcement,
    criteria: verdicts,
    total,
    passed_count,
    model,
  };

  return new Response(JSON.stringify({ success: true, data: result }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-RateLimit-Limit": String(decision.limit),
      "X-RateLimit-Remaining": String(decision.remaining),
    },
  });
}
