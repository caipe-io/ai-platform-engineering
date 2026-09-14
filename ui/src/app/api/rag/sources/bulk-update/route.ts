/**
 * `POST /api/rag/sources/bulk-update` — apply an Owner and/or Search Access
 * change across many datasources at once.
 *
 * This is a self-service tool, not an admin bypass: every source in
 * `source_ids` goes through exactly the same authorization and
 * publication-approval logic a single `PATCH /api/rag/sources/[sourceId]`
 * edit would trigger - literally, by invoking that route's exported `PATCH`
 * handler in-process once per source, rather than re-implementing its
 * config-driven guard, immutable-field checks, approval-gating, and
 * rollback-on-failure logic a second time. A source the caller can't manage
 * simply comes back as a per-source 403 in `results`, exactly as it would
 * from a single-source PATCH; nothing here bypasses that check.
 *
 * `getServerSession()` (used by `getAuthFromBearerOrSession` for
 * cookie-authenticated callers) reads Next.js's ambient per-request context,
 * not whatever `NextRequest` object is passed to the handler - so invoking
 * `PATCH` in-process from within this route's own request execution resolves
 * the same session as this route without any extra plumbing. A caller using
 * bearer-token auth is supported too: the incoming `Authorization` header is
 * forwarded onto each synthetic per-source request.
 */

import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { mapWithConcurrency } from "@/lib/rbac/openfga";
import type { IngestionSourceConfig } from "@/types/ingestion-source";

import { PATCH as patchSource } from "../[sourceId]/route";

const COLLECTION_NAME = "rag_ingestion_sources";
const MAX_BULK_SOURCES = 500;
const BULK_CONCURRENCY = 10;

type SourceResultStatus = "updated" | "pending_approval" | "skipped";

interface SourceResult {
  source_id: string;
  status: SourceResultStatus;
  reason?: string;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function parseSourceIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError(
      "source_ids must be a non-empty array",
      400,
      "INVALID_SOURCE_IDS",
    );
  }
  const ids = unique(
    raw.map((value) => {
      const id = normalizeString(value);
      if (!id) {
        throw new ApiError(
          "source_ids must contain datasource ids",
          400,
          "INVALID_SOURCE_IDS",
        );
      }
      return id;
    }),
  );
  if (ids.length > MAX_BULK_SOURCES) {
    throw new ApiError(
      `A bulk edit can include at most ${MAX_BULK_SOURCES} sources`,
      400,
      "TOO_MANY_SOURCE_IDS",
    );
  }
  return ids;
}

function parseOwner(body: Record<string, unknown>): {
  requested: boolean;
  teamSlug: string | null;
  subject: string | null;
} {
  const owner = body.owner;
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
    return { requested: false, teamSlug: null, subject: null };
  }
  const ownerBody = owner as Record<string, unknown>;
  const teamSlug = normalizeString(ownerBody.team_slug);
  const subject = teamSlug ? null : normalizeString(ownerBody.subject);
  if (!teamSlug && !subject) {
    throw new ApiError(
      "owner.team_slug or owner.subject is required when applying an Owner",
      400,
      "OWNER_REQUIRED",
    );
  }
  return { requested: true, teamSlug, subject };
}

function parseSearch(body: Record<string, unknown>): {
  requested: boolean;
  mode: "replace" | "additive";
  teamSlugs: string[];
  userSubjects: string[];
} {
  const search = body.search;
  if (!search || typeof search !== "object" || Array.isArray(search)) {
    return { requested: false, mode: "replace", teamSlugs: [], userSubjects: [] };
  }
  const searchBody = search as Record<string, unknown>;
  const mode = searchBody.mode === "additive" ? "additive" : "replace";
  return {
    requested: true,
    mode,
    teamSlugs: normalizeStringArray(searchBody.team_slugs),
    userSubjects: normalizeStringArray(searchBody.user_subjects),
  };
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  // The per-source PATCH invocation below independently re-authenticates
  // and re-authorizes each source; this call only rejects an unauthenticated
  // caller before doing any work.
  await getAuthFromBearerOrSession(request);
  const authHeader = request.headers.get("Authorization");
  // Forwarded so each per-source call hits the same session-auth cache the
  // outer request already populated, instead of every one of up to
  // MAX_BULK_SOURCES calls re-running a full getServerSession() lookup.
  const cookieHeader = request.headers.get("Cookie");

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError("Request body must be an object", 400, "INVALID_BODY");
    }
    body = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("Invalid JSON body", 400, "INVALID_JSON");
  }

  const sourceIds = parseSourceIds(body.source_ids);
  const owner = parseOwner(body);
  const search = parseSearch(body);
  if (!owner.requested && !search.requested) {
    throw new ApiError(
      "Specify an Owner and/or Search Access to apply",
      400,
      "NOTHING_TO_APPLY",
    );
  }

  const sources = await getCollection<IngestionSourceConfig>(COLLECTION_NAME);

  const results = await mapWithConcurrency(
    sourceIds,
    BULK_CONCURRENCY,
    async (sourceId): Promise<SourceResult> => {
      // The whole body is guarded, not just the `patchSource` call: a
      // transient failure anywhere for one source (e.g. a Mongo blip on its
      // own `findOne`) must not reject `mapWithConcurrency`'s `Promise.all`
      // and take down every other source's already-in-flight or
      // already-applied result with it.
      try {
        const existing = await sources.findOne({ source_id: sourceId } as never);
        if (!existing) {
          return { source_id: sourceId, status: "skipped", reason: "not_found" };
        }

        const perSourceBody: Record<string, unknown> = {};
        if (owner.requested) {
          if (owner.teamSlug) perSourceBody.owner_team_slug = owner.teamSlug;
          else if (owner.subject) perSourceBody.owner_subject = owner.subject;
        }
        if (search.requested) {
          const previousSearchTeamSlugs = Array.isArray(existing.search_with_teams)
            ? existing.search_with_teams
            : existing.search_owner_team_slug
              ? [existing.search_owner_team_slug]
              : [];
          const previousSearchUserSubjects = Array.isArray(existing.search_with_users)
            ? existing.search_with_users
            : [];
          perSourceBody.search_team_slugs =
            search.mode === "additive"
              ? unique([...previousSearchTeamSlugs, ...search.teamSlugs])
              : search.teamSlugs;
          perSourceBody.search_user_subjects =
            search.mode === "additive"
              ? unique([...previousSearchUserSubjects, ...search.userSubjects])
              : search.userSubjects;
        }

        const syntheticRequest = new NextRequest(
          new URL(`/api/rag/sources/${encodeURIComponent(sourceId)}`, request.url),
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              ...(authHeader ? { Authorization: authHeader } : {}),
              ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            },
            body: JSON.stringify(perSourceBody),
          },
        );

        const response = await patchSource(syntheticRequest, {
          params: Promise.resolve({ sourceId }),
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.success) {
          return {
            source_id: sourceId,
            status: "skipped",
            reason: payload?.code ?? `HTTP_${response.status}`,
          };
        }
        if (payload.data?._publication_request) {
          return { source_id: sourceId, status: "pending_approval" };
        }
        return { source_id: sourceId, status: "updated" };
      } catch (error) {
        // withErrorHandler normally converts ApiError into a Response, but
        // guard here too so one source's unexpected throw can't fail the
        // whole batch for every other source running concurrently.
        return {
          source_id: sourceId,
          status: "skipped",
          reason: error instanceof ApiError ? error.code ?? "ERROR" : "ERROR",
        };
      }
    },
  );

  return successResponse({
    results,
    updated_count: results.filter((r) => r.status === "updated").length,
    pending_approval_count: results.filter((r) => r.status === "pending_approval").length,
    skipped_count: results.filter((r) => r.status === "skipped").length,
  });
});
