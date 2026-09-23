/**
 * Caller-side authorization for credentials attached to RAG ingestion sources.
 *
 * The ingestor's own read access is derived from the source that references a
 * credential — see `credentials/ingest-credential-usage.server.ts`. What has to
 * happen here is the other half: proving the caller is allowed to point the
 * ingestor at a credential in the first place.
 */

import { ApiError } from "@/lib/api-error";
import { recordIngestPreviewGrant } from "@/lib/credentials/ingest-credential-usage.server";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import type { WebAuthHeader } from "@/types/ingestion-source";

type AuthzSession = Parameters<typeof requireResourcePermission>[0];

/**
 * The distinct credential references a source's settings depend on.
 *
 * Static headers carry no reference, so they are filtered out rather than
 * producing an empty subject for the authorization check below.
 */
export function secretRefsFromSettings(settings: unknown): string[] {
  const authHeaders =
    (settings as { auth_headers?: WebAuthHeader[] } | null | undefined)?.auth_headers ?? [];
  return Array.from(
    new Set(
      authHeaders
        .map((header) => header.secret_ref?.trim())
        .filter((secretRef): secretRef is string => Boolean(secretRef)),
    ),
  );
}

/**
 * Collect a source's credential references after proving the caller may use each.
 *
 * This is the security boundary for authenticated ingestion: the ingestor will
 * send a resolved credential to whatever URL the source names, so without this
 * check any caller able to create or edit a source could reference a credential
 * they cannot read and have it replayed to a host they control.
 */
export async function authorizedSourceSecretRefs(
  session: AuthzSession,
  settings: unknown,
): Promise<string[]> {
  const secretRefs = secretRefsFromSettings(settings);

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

/**
 * Authorizes a test or preview, which runs before a source exists.
 *
 * Once a source is saved its credentials are reachable because the source
 * references them, so only this earlier window needs recording.
 */
export async function authorizeIngestPreviewCredentials(input: {
  session: AuthzSession;
  settings: unknown;
}): Promise<string[]> {
  const secretRefs = await authorizedSourceSecretRefs(input.session, input.settings);
  if (secretRefs.length === 0) return secretRefs;

  const subject = typeof input.session.sub === "string" ? input.session.sub : "unknown";
  await Promise.all(
    secretRefs.map((secretRef) => recordIngestPreviewGrant({ secretRef, subject })),
  );
  return secretRefs;
}
