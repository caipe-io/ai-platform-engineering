/**
 * Recognized-ingestor-service-account bypass for RAG ingestion sources
 * (spec 2026-07-21-rag-source-config-db).
 *
 * First-party ingestor pods (Slack, Confluence, Jira, web, Webex) call
 * `GET /api/rag/sources` and `PATCH /api/rag/sources/[sourceId]/status` as
 * Keycloak service accounts, scoped by `source_type` rather than by
 * per-resource OpenFGA tuples — provisioning an `ingestion_source#reader`
 * tuple per ingestor per source would require reconciling that grant on
 * every create/delete, for callers that only ever need "all sources of my
 * declared type or types."
 *
 * `RAG_INGESTOR_SERVICE_ACCOUNTS` maps the *raw* Keycloak `sub` (not
 * `preferred_username`) to the list of source types that identity may act
 * on. Keyed on `sub` because that's the stable claim `resource-authz.ts`
 * composes into `service_account:<sub>` — `preferred_username` is a
 * display-only Keycloak stamp derived from the client id.
 */

import type { IngestionSourceType } from "@/types/ingestion-source";
import type { ResourceAuthzSession } from "./resource-authz";

let _cachedRaw: string | undefined;
let _cachedMap: Map<string, Set<IngestionSourceType>> | null = null;

function parseIngestorServiceAccountsEnv(raw: string): Map<string, Set<IngestionSourceType>> {
  const map = new Map<string, Set<IngestionSourceType>>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[ingestor-service-accounts] RAG_INGESTOR_SERVICE_ACCOUNTS is not valid JSON; ignoring");
    return map;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn("[ingestor-service-accounts] RAG_INGESTOR_SERVICE_ACCOUNTS must be a JSON object; ignoring");
    return map;
  }
  for (const [sub, sourceTypes] of Object.entries(parsed as Record<string, unknown>)) {
    if (!sub.trim() || !Array.isArray(sourceTypes)) continue;
    const types = sourceTypes.filter((t): t is IngestionSourceType => typeof t === "string");
    if (types.length > 0) {
      map.set(sub.trim(), new Set(types));
    }
  }
  return map;
}

function getIngestorServiceAccountsMap(): Map<string, Set<IngestionSourceType>> {
  const raw = process.env.RAG_INGESTOR_SERVICE_ACCOUNTS ?? "";
  if (raw === _cachedRaw && _cachedMap) {
    return _cachedMap;
  }
  _cachedRaw = raw;
  _cachedMap = raw.trim() ? parseIngestorServiceAccountsEnv(raw) : new Map();
  return _cachedMap;
}

/** Allow-listed source types for a recognized ingestor service account, or `null` if unrecognized. */
export function allowedSourceTypesForIngestorServiceAccount(
  session: ResourceAuthzSession,
): Set<IngestionSourceType> | null {
  if (session.isServiceAccount !== true) return null;
  if (typeof session.sub !== "string" || !session.sub.trim()) return null;
  return getIngestorServiceAccountsMap().get(session.sub.trim()) ?? null;
}

/** True when `session` is a recognized ingestor service account scoped to `sourceType`. */
export function isRecognizedIngestorServiceAccount(
  session: ResourceAuthzSession,
  sourceType: IngestionSourceType,
): boolean {
  const allowed = allowedSourceTypesForIngestorServiceAccount(session);
  return allowed !== null && allowed.has(sourceType);
}

/** Reset the cached env parse (for tests that mutate `process.env` between cases). */
export function _resetIngestorServiceAccountsCacheForTests(): void {
  _cachedRaw = undefined;
  _cachedMap = null;
}
