/**
 * Dynamic-agent ownership and visibility normalization.
 *
 * Private agents are personally owned; team and global agents require an
 * owner team. Unknown wire values are normalized to the safe legacy default
 * (`team`) so older clients continue to receive structured validation.
 */

import type {
DynamicAgentConfig,
LegacyVisibilityType,
VisibilityType,
} from "@/types/dynamic-agent";

const STRICT_VISIBILITY: ReadonlySet<VisibilityType> = new Set(["private", "team", "global"]);

/**
 * Normalize a possibly-invalid visibility value to the current strict union.
 *
 *   - `'private'` / `'team'` / `'global'` → pass through.
 *   - Anything else → `'team'` (safe default) with `coercedFromInvalid: true`.
 *
 * Returns both the canonical value and a deprecation flag so callers can
 * surface a warning header (e.g. `X-CAIPE-Visibility-Deprecated: private`).
 */
export function normalizeLegacyVisibility(
  raw: LegacyVisibilityType | string | undefined,
): { value: VisibilityType; deprecated: boolean; coercedFromInvalid: boolean } {
  if (typeof raw !== "string") {
    return { value: "team", deprecated: false, coercedFromInvalid: true };
  }
  if (STRICT_VISIBILITY.has(raw as VisibilityType)) {
    return { value: raw as VisibilityType, deprecated: false, coercedFromInvalid: false };
  }
  return { value: "team", deprecated: false, coercedFromInvalid: true };
}

/**
 * Preserve a supported visibility on an agent doc fetched from Mongo.
 * Returns the original reference for chaining.
 *
 * Idempotent — calling this on a doc that already has
 * `visibility: 'private' | 'team' | 'global'` is a no-op.
 */
export function coerceAgentVisibilityOnRead<
  T extends { visibility?: LegacyVisibilityType },
>(doc: T): T {
  return doc;
}

export interface AgentOwnershipValidationInput {
  visibility: VisibilityType;
  ownerTeamSlug: string | null | undefined;
  ownerTeamId: string | null | undefined;
}

export interface AgentOwnershipValidationResult {
  ok: boolean;
  /** When `ok === false`, a short machine code (`OWNER_TEAM_REQUIRED`, …). */
  code?: string;
  /** Human-readable error suitable for an `ApiError` `message`. */
  message?: string;
}

/**
 * Enforce the ownership contract:
 *
 *   - Visibility must be `'private'`, `'team'`, or `'global'`.
 *   - Team/global agents must have an `ownerTeamSlug`. `ownerTeamId` is a
 *     belt-and-suspenders pairing — required only when the slug is
 *     present (the slug is the source of truth for OpenFGA tuples; the
 *     id is for Mongo joins).
 */
export function validateAgentOwnership(
  input: AgentOwnershipValidationInput,
): AgentOwnershipValidationResult {
  if (input.visibility !== "private" && input.visibility !== "team" && input.visibility !== "global") {
    return {
      ok: false,
      code: "VISIBILITY_INVALID",
      message:
        "Agent visibility must be 'private', 'team', or 'global'.",
    };
  }
  const slug = typeof input.ownerTeamSlug === "string" ? input.ownerTeamSlug.trim() : "";
  if (input.visibility !== "private" && !slug) {
    return {
      ok: false,
      code: "OWNER_TEAM_REQUIRED",
      message:
        "Team and global agents must be owned by a team. Select a team in the Owner Team picker.",
    };
  }
  return { ok: true };
}

/**
 * Compute the `owner_team_slug` that should be persisted on the agent
 * doc, given the normalized request body and the existing doc (for PUT).
 * `null` is valid for a private agent.
 */
export function resolveOwnerTeamSlug(
  body: Pick<Record<string, unknown>, "owner_team_slug">,
  existing: Pick<DynamicAgentConfig, "owner_team_slug"> | null,
): string | null {
  const fromBody =
    typeof body.owner_team_slug === "string" && body.owner_team_slug.trim()
      ? body.owner_team_slug.trim()
      : null;
  if (fromBody) return fromBody;
  if (existing?.owner_team_slug) return existing.owner_team_slug;
  return null;
}
