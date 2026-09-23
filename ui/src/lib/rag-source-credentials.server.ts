/**
 * Authorization and grant reconciliation for credentials attached to RAG
 * ingestion sources.
 *
 * Ingestors resolve stored credentials under their own service-account identity,
 * never the end user's, so two separate things have to hold: the caller must be
 * allowed to use a credential before attaching it, and the ingestor must be
 * granted `use` on it afterwards.
 */

import { ApiError } from "@/lib/api-error";
import {
  deleteSecretRefServiceAccountUse,
  reconcileSecretRefServiceAccountUse,
} from "@/lib/credentials/secret-openfga";
import { getCollection } from "@/lib/mongodb";
import { ingestorServiceAccountSubjectsForSourceType } from "@/lib/rbac/ingestor-service-accounts";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import type {
  IngestionSourceConfig,
  IngestionSourceType,
  WebAuthHeader,
} from "@/types/ingestion-source";

const COLLECTION_NAME = "rag_ingestion_sources";

type AuthzSession = Parameters<typeof requireResourcePermission>[0];

/** The distinct credential references a source's settings depend on. */
export function secretRefsFromSettings(settings: unknown): string[] {
  const authHeaders =
    (settings as { auth_headers?: WebAuthHeader[] } | null | undefined)?.auth_headers ?? [];
  return Array.from(new Set(authHeaders.map((header) => header.secret_ref)));
}

/**
 * Collect a source's credential references after proving the caller may use each.
 *
 * This is the security boundary for authenticated ingestion: without it, any
 * caller able to create or edit a source could reference a credential they cannot
 * read and have the ingestor replay it, turning ingestion into an exfiltration
 * path.
 */
export async function authorizedSourceSecretRefs(
  session: AuthzSession,
  settings: unknown,
  sourceType: IngestionSourceType,
): Promise<string[]> {
  const secretRefs = secretRefsFromSettings(settings);

  // Checked before the source is persisted: the grant is written afterwards, and
  // failing here avoids leaving a source that can never authenticate.
  if (secretRefs.length > 0 && ingestorServiceAccountSubjectsForSourceType(sourceType).length === 0) {
    throw new ApiError(
      `This deployment has no ${sourceType} ingestor identity registered, so a credential cannot be attached. Set RAG_INGESTOR_SERVICE_ACCOUNTS for the ingestor before using authenticated sources.`,
      503,
      "INGESTOR_IDENTITY_NOT_CONFIGURED",
    );
  }

  for (const secretRef of secretRefs) {
    try {
      await requireResourcePermission(session, {
        type: "secret_ref",
        id: secretRef,
        action: "use",
      });
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 401) throw error;
      throw new ApiError(
        `You do not have permission to use the credential "${secretRef}"`,
        403,
        "FORBIDDEN_CREDENTIAL",
      );
    }
  }
  return secretRefs;
}

async function secretIsUsedByAnotherSource(
  secretRef: string,
  excludeSourceId: string,
): Promise<boolean> {
  const collection = await getCollection<IngestionSourceConfig>(COLLECTION_NAME);
  const match = await collection.findOne({
    source_id: { $ne: excludeSourceId },
    "settings.auth_headers.secret_ref": secretRef,
  } as never);
  return match !== null;
}

/**
 * Align the ingestor's credential grants with what a source now references.
 *
 * A removed credential is only revoked when no other source still depends on it,
 * since the grant is per-credential rather than per-source.
 */
export async function reconcileIngestorSecretAccess(input: {
  sourceId: string;
  sourceType: IngestionSourceType;
  previousSecretRefs: string[];
  nextSecretRefs: string[];
}): Promise<void> {
  const ingestorSubjects = ingestorServiceAccountSubjectsForSourceType(input.sourceType);
  if (ingestorSubjects.length === 0) return;

  const next = new Set(input.nextSecretRefs);
  const previous = new Set(input.previousSecretRefs);

  const added = input.nextSecretRefs.filter((ref) => !previous.has(ref));
  const removed = input.previousSecretRefs.filter((ref) => !next.has(ref));

  await Promise.all(
    added.map((ref) => reconcileSecretRefServiceAccountUse(ref, ingestorSubjects)),
  );

  for (const ref of removed) {
    if (await secretIsUsedByAnotherSource(ref, input.sourceId)) continue;
    await deleteSecretRefServiceAccountUse(ref, ingestorSubjects);
  }
}
