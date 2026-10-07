/**
 * `PATCH /api/rag/sources/[sourceId]/status` — lets a recognized ingestor
 * service account (spec 2026-07-21-rag-source-config-db) report ingestion
 * progress by updating `status` only.
 *
 * Scoped to `RAG_INGESTOR_SERVICE_ACCOUNTS`: the caller must be a service
 * account whose declared `source_type` allow-list includes the target
 * source's `source_type`. Unlike the general `[sourceId]` PATCH route, this
 * route deliberately works on `config_driven: true` records too — the
 * ingestor needs to report status regardless of who authored the source
 * config, and status is not an identity/config field. It never touches
 * OpenFGA tuples, since status has no bearing on who can read/manage the
 * source.
 */

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { isRecognizedIngestorServiceAccount } from "@/lib/rbac/ingestor-service-accounts";
import type { IngestionSourceConfig, IngestionSourceStatus } from "@/types/ingestion-source";
import { NextRequest } from "next/server";

const COLLECTION_NAME = "rag_ingestion_sources";

const VALID_STATUSES: readonly IngestionSourceStatus[] = [
  "pending",
  "active",
  "disabled",
  "ingesting",
  "failed",
];

export const PATCH = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ sourceId: string }> }) => {
    const { sourceId } = await context.params;
    const { session } = await getAuthFromBearerOrSession(request);

    const collection = await getCollection<IngestionSourceConfig>(COLLECTION_NAME);
    const source = await collection.findOne({ source_id: sourceId } as never);
    if (!source) {
      throw new ApiError("Source not found", 404, "SOURCE_NOT_FOUND");
    }

    if (!isRecognizedIngestorServiceAccount(session, source.source_type)) {
      throw new ApiError(
        "Only a recognized ingestor service account scoped to this source's type may update status",
        403,
        "FORBIDDEN_INGESTOR_STATUS_UPDATE",
      );
    }

    const body = (await request.json()) as Record<string, unknown>;
    const rawStatus = body.status;
    if (typeof rawStatus !== "string" || !VALID_STATUSES.includes(rawStatus as IngestionSourceStatus)) {
      throw new ApiError(
        `status must be one of: ${VALID_STATUSES.join(", ")}`,
        400,
        "INVALID_STATUS",
      );
    }
    const status: IngestionSourceStatus = rawStatus as IngestionSourceStatus;

    const updated = await collection.findOneAndUpdate(
      { source_id: sourceId } as never,
      { $set: { status, updated_at: new Date().toISOString() } },
      { returnDocument: "after" },
    );
    if (!updated) {
      throw new ApiError("Failed to update source status", 500);
    }

    return successResponse(updated);
  },
);
