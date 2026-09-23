/**
 * Authorizes an ingestor's credential reads by what it is actually being asked
 * to crawl, rather than by a granted relationship.
 *
 * Ingestors run under their own identity with no user in the loop, so the
 * alternative would be a standing grant per credential, written when a source is
 * saved and reconciled when it changes. Deriving access from the source that
 * references the credential keeps the ingestor invisible to configuration, and
 * makes the lifecycle automatic: access exists while a source needs it and ends
 * when that source stops referencing it.
 *
 * Testing or previewing happens before a source exists, which is what the
 * short-lived preview grant covers.
 */

import { getCollection } from "@/lib/mongodb";

import { CREDENTIAL_COLLECTIONS } from "./collections";

const INGESTION_SOURCES_COLLECTION = "rag_ingestion_sources";

/** Long enough to configure and test a source, short enough to be forgettable. */
const PREVIEW_GRANT_TTL_MS = 15 * 60_000;

interface IngestPreviewGrantDocument {
  secret_ref: string;
  granted_to_subject: string;
  expires_at: Date;
}

/** True when a saved ingestion source references this credential. */
export async function secretIsReferencedByIngestionSource(
  secretRef: string,
): Promise<boolean> {
  const collection = await getCollection(INGESTION_SOURCES_COLLECTION);
  const match = await collection.findOne({
    "settings.auth_headers.secret_ref": secretRef,
  } as never);
  return match !== null;
}

/**
 * Notes that a caller who may use this credential has asked the ingestor to try
 * it, so a preview can resolve it before any source exists.
 */
export async function recordIngestPreviewGrant(input: {
  secretRef: string;
  subject: string;
}): Promise<void> {
  const collection = await getCollection<IngestPreviewGrantDocument>(
    CREDENTIAL_COLLECTIONS.ingestPreviewGrants,
  );
  await collection.updateOne(
    { secret_ref: input.secretRef } as never,
    {
      $set: {
        secret_ref: input.secretRef,
        granted_to_subject: input.subject,
        expires_at: new Date(Date.now() + PREVIEW_GRANT_TTL_MS),
      },
    } as never,
    { upsert: true },
  );
}

/**
 * True when an unexpired preview grant covers this credential. Expired records
 * are cleared as they are encountered, so no scheduled sweep is required.
 */
export async function hasActiveIngestPreviewGrant(secretRef: string): Promise<boolean> {
  const collection = await getCollection<IngestPreviewGrantDocument>(
    CREDENTIAL_COLLECTIONS.ingestPreviewGrants,
  );
  const grant = await collection.findOne({ secret_ref: secretRef } as never);
  if (!grant) return false;
  if (new Date(grant.expires_at).getTime() > Date.now()) return true;
  await collection.deleteOne({ secret_ref: secretRef } as never);
  return false;
}

/** Whether an ingestor may resolve this credential right now. */
export async function ingestorMayUseSecret(secretRef: string): Promise<boolean> {
  if (await secretIsReferencedByIngestionSource(secretRef)) return true;
  return hasActiveIngestPreviewGrant(secretRef);
}
