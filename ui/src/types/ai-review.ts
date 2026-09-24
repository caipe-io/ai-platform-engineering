/**
 * Shared types for the AI Review feature.
 *
 * The review feature grades a piece of content (an agent system prompt, a
 * SKILL.md, etc.) against an admin-configurable rubric of small atomic
 * criteria. Each criterion runs as its own LLM call so the rubric scales
 * to many checks without context bloat. Verdicts are aggregated into a
 * weighted score and a letter grade. Optionally, blocking enforcement
 * gates the parent wizard's Next/Save buttons until the review passes.
 *
 * Types here form the contract between:
 *   - the backend route POST /api/ai/review
 *   - the admin CRUD route /api/review-configs
 *   - the reusable frontend module under components/ai-review/
 *   - both consumer flows (DynamicAgentEditor + SkillWorkspace)
 */

// ---------------------------------------------------------------------------
// Severity & enforcement
// ---------------------------------------------------------------------------

/** How urgent a failed criterion is. Drives badge color and (admin-tunable)
 * weight contribution. */
export type ReviewSeverity = "info" | "warning" | "error";

/** Whether a failing review blocks the parent wizard from advancing. */
export type ReviewEnforcement = "blocking" | "informational";

/** Letter grade buckets the score is mapped into for display. */
export type ReviewGrade = "A" | "B" | "C" | "D" | "F";

// ---------------------------------------------------------------------------
// Suggested fixes
// ---------------------------------------------------------------------------

/**
 * A model-suggested patch the user can apply with one click.
 *
 * - `replace_all`: overwrite the entire document with `text`.
 * - `replace_range`: splice lines [line_start, line_end] (inclusive, 0-based)
 *   with `text.split("\n")`. Out-of-range indices clamp; ambiguous ranges
 *   should fall back to append-as-comment rather than corrupt content.
 */
export type SuggestedFix =
  | {
      kind: "replace_all";
      text: string;
      summary: string;
    }
  | {
      kind: "replace_range";
      line_start: number;
      line_end: number;
      text: string;
      summary: string;
    };

/** Anchor a comment to a line range in the reviewed content (0-based, inclusive). */
export interface ReviewAnchor {
  line_start: number;
  line_end: number;
}

// ---------------------------------------------------------------------------
// Rubric configuration (admin-editable)
// ---------------------------------------------------------------------------

/**
 * One small atomic check. The `micro_prompt` is intentionally tiny — the
 * server wraps it in a fixed envelope that asks for strict-JSON output.
 * Keeping criteria small means N criteria run in N parallel LLM calls
 * with O(content_size) tokens each, regardless of how many criteria the
 * admin adds.
 */
export interface ReviewCriterion {
  /** Stable slug; must be unique per config. */
  id: string;
  /** Short human label shown in the panel. */
  name: string;
  /** Drives badge color and visibility rules in the UI. */
  severity: ReviewSeverity;
  /** Score weight. Defaults to 1 when omitted. */
  weight: number;
  /** The admin-authored small prompt — a single yes/no judgment. */
  micro_prompt: string;
  /**
   * Whether this criterion is allowed to produce a `suggested_fix`. When
   * false, the server strips any `suggested_fix` the model returns.
   */
  expects_fix: boolean;
}

/** Admin-tunable letter-grade thresholds (score in [0, 1]). */
export interface GradeThresholds {
  A: number;
  B: number;
  C: number;
  D: number;
}

/** Default thresholds when an admin hasn't customized them. */
export const DEFAULT_GRADE_THRESHOLDS: GradeThresholds = {
  A: 0.9,
  B: 0.8,
  C: 0.7,
  D: 0.6,
};

/**
 * One config document in the `review_configs` Mongo collection. The `_id`
 * matches `target` so both wire formats round-trip.
 */
export interface ReviewConfig {
  _id: string;
  /** Stable target id used by consumers (e.g. "agent-system-prompt"). */
  target: string;
  /** Display label for the admin tab. */
  label: string;
  /** Master switch — when false, the review button hides in consumers. */
  enabled: boolean;
  enforcement: ReviewEnforcement;
  /** Pass threshold (0..1). Only consulted when enforcement === "blocking". */
  min_score: number;
  grade_thresholds: GradeThresholds;
  /** Per-target model override; falls back to the Platform LLM when unset. */
  model?: { id?: string; provider?: string };
  criteria: ReviewCriterion[];
  updated_at: string;
  /** Email of the last admin that edited this config. */
  updated_by?: string;
}

/** Update-payload — partial; updated_at is server-stamped. */
export type ReviewConfigUpdate = Partial<
  Omit<ReviewConfig, "_id" | "target" | "updated_at" | "model">
> & {
  /**
   * Null clears the pinned model so the target falls back to the Platform LLM.
   * Omitting the key leaves whatever is stored untouched.
   */
  model?: { id?: string; provider?: string } | null;
};

// ---------------------------------------------------------------------------
// Run-time review request / response
// ---------------------------------------------------------------------------

/**
 * Free-form context bag passed to the backend so criteria can consider
 * surrounding form state. Shape mirrors `AiAssistContext` in
 * `lib/server/ai-assist-tasks.ts` so consumers can pass the same object
 * they'd build for AI Suggest.
 */
export interface ReviewContext {
  name?: string;
  description?: string;
  agent_description?: string;
  skill_description?: string;
  language?: string;
  shell?: string;
  extra_context?: string;
}

/** Verdict for a single criterion after aggregation. */
export interface CriterionVerdict {
  id: string;
  name: string;
  severity: ReviewSeverity;
  weight: number;
  pass: boolean;
  /** Empty when pass=true and severity != "info". */
  comment: string;
  anchor: ReviewAnchor | null;
  suggested_fix: SuggestedFix | null;
  /**
   * Populated when this single criterion's LLM call failed (network error,
   * unparseable JSON, etc.). The criterion is treated as a fail with weight
   * applied to denominator only — never punishes the user for an LLM glitch.
   */
  error: string | null;
}

/** Full response from POST /api/ai/review. */
export interface ReviewResult {
  /** Echo of the request hash so the client can confirm cache validity. */
  hash: string;
  /** Weighted pass ratio in [0, 1]. */
  score: number;
  grade: ReviewGrade;
  /** True when score >= config.min_score (or when enforcement informational). */
  passed: boolean;
  enforcement: ReviewEnforcement;
  criteria: CriterionVerdict[];
  /** Total criteria evaluated (criteria with error are still counted). */
  total: number;
  /** Criteria where pass=true. */
  passed_count: number;
  /** Model that was used (echoed for debugging). */
  model: { id: string; provider: string };
}

/**
 * Compact summary of the most recent review run, persisted on the reviewed
 * document (e.g. a dynamic agent or an agent skill) so list views can show a
 * grade badge without re-running the rubric. Stamped client-side on save when
 * a fresh `ReviewResult` exists for the saved content.
 */
export interface LastReview {
  /** Letter grade from `ReviewResult.grade`. */
  grade: ReviewGrade;
  /** Weighted score in [0, 1] from `ReviewResult.score`. */
  score: number;
  /** sha-256 of the content that produced this verdict. Used to detect
   *  drift — UI can dim the badge when the live content hash differs. */
  hash: string;
  /** Target id from `review_configs` (e.g. "agent-system-prompt"). */
  target: string;
  /** ISO-8601 timestamp the review completed. */
  reviewed_at: string;
  /** True iff `score >= config.min_score` at the time of save. */
  passed: boolean;
}

/** Body of POST /api/ai/review. */
export interface ReviewRequest {
  /** Matches a `target` in review_configs. */
  target: string;
  content: string;
  /** Hex sha-256 of `content` computed by the client. */
  content_hash: string;
  context?: ReviewContext;
}
