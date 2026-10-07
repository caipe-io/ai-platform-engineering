/**
 * `POST /api/rag/sources/[sourceId]/adopt` — permanently converts a
 * Helm-seeded (`config_driven: true`) ingestion source into a DB-native
 * record (spec 2026-07-21-rag-source-config-db, US5).
 *
 * Org-admin only, mirroring `sync-from-config/route.ts`'s
 * `requireRbacPermission(session, "admin_ui", "admin")` gate — adoption
 * reassigns team ownership org-wide, which is a stronger action than the
 * per-resource `manage` permission PATCH/DELETE require.
 */

import {
  ApiError,
  getAuthFromBearerOrSession,
  requireRbacPermission,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { adoptConfigImportedRagSources } from "@/lib/seed-config";
import type { IngestionSourceConfig } from "@/types/ingestion-source";
import type { Team } from "@/types/teams";
import { NextRequest } from "next/server";

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const POST = withErrorHandler(
  async (request: NextRequest, context: { params: Promise<{ sourceId: string }> }) => {
    const { sourceId } = await context.params;
    const { session } = await getAuthFromBearerOrSession(request);
    await requireRbacPermission(session, "admin_ui", "admin");

    const collection = await getCollection<IngestionSourceConfig>("rag_ingestion_sources");
    const existing = await collection.findOne({ source_id: sourceId } as never);
    if (!existing) {
      throw new ApiError("Source not found", 404, "SOURCE_NOT_FOUND");
    }
    if (existing.config_driven !== true || existing.config_import_adopted === true) {
      throw new ApiError(
        "Source is not eligible for adoption (already adopted or not config-driven)",
        409,
        "SOURCE_NOT_ADOPTABLE",
      );
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const ownerTeamSlug = normalizeString(body.owner_team_slug);
    if (Object.prototype.hasOwnProperty.call(body, "shared_with_teams")) {
      throw new ApiError(
        "A datasource has one Owner team. Add other teams under Search.",
        400,
        "MANAGEMENT_SHARING_NOT_SUPPORTED",
      );
    }
    if (!ownerTeamSlug) {
      throw new ApiError(
        "owner_team_slug is required when adopting a config-driven source",
        400,
        "OWNER_TEAM_REQUIRED",
      );
    }

    const teams = await getCollection<Team>("teams");
    const team = await teams.findOne({ slug: ownerTeamSlug } as never);
    if (!team) {
      throw new ApiError(`Owner team "${ownerTeamSlug}" not found`, 404, "OWNER_TEAM_NOT_FOUND");
    }

    const { skipped } = await adoptConfigImportedRagSources([sourceId], {
      ownerTeamSlug,
    });
    if (skipped.some((s) => s.source_id === sourceId)) {
      throw new ApiError(
        "Source is not eligible for adoption (already adopted or not config-driven)",
        409,
        "SOURCE_NOT_ADOPTABLE",
      );
    }

    const updated = await collection.findOne({ source_id: sourceId } as never);
    return successResponse(updated);
  },
);
