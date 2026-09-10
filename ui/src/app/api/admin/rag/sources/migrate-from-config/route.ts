/**
 * Adopt application-config RAG sources into UI-managed database records.
 *
 * Startup seeding already persists each valid `rag_sources` entry as a
 * read-only `config_driven` row. Adoption transfers configuration ownership
 * to MongoDB, adds the selected sources to a managed collection, and makes
 * them editable without re-ingesting their indexed content.
 */

import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  requireRbacPermission,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import {
  extractIngestionSourceTypeFields,
  validateSourceSpecificInputFields,
} from "@/lib/ingestion-source-config";
import { computeIngestionSourceId } from "@/lib/ingestion-source-id";
import { getCollection } from "@/lib/mongodb";
import {
  bootstrapPlatformRagCollection,
  RAG_COLLECTION_ID_PATTERN,
  RAG_COLLECTIONS_COLLECTION,
  replaceCollectionSources,
} from "@/lib/rag-collections.server";
import {
  adoptConfigImportedRagSources,
  loadSeedConfig,
  type RagSourceAdoptSkipReason,
} from "@/lib/seed-config";
import { caipeOrgKey } from "@/lib/rbac/organization";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import type {
  IngestionSourceConfig,
  IngestionSourceType,
} from "@/types/ingestion-source";
import {
  PLATFORM_RAG_COLLECTION_ID,
  type RagCollection,
} from "@/types/rag-collection";

const MAX_ADOPTION_SOURCES = 500;

type PreviewUnavailableReason = "not_seeded" | "not_config_driven";

interface ConfigSourcePreview {
  source_id: string;
  name: string;
  source_type: IngestionSourceType;
  in_db: boolean;
  already_adopted: boolean;
  importable: boolean;
  unavailable_reason?: PreviewUnavailableReason;
}

type AdoptSkipReason =
  | RagSourceAdoptSkipReason
  | "not_in_config"
  | "not_seeded";

interface AdoptSkip {
  source_id: string;
  reason: AdoptSkipReason;
}

interface AdoptFromConfigResult {
  sources: ConfigSourcePreview[];
  adopted?: string[];
  skipped?: AdoptSkip[];
  configured_source_count: number;
  destination_collection: {
    id: string;
    source_count: number;
  };
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseSourceIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new ApiError(
      "source_ids must be an array",
      400,
      "INVALID_SOURCE_IDS",
    );
  }
  const ids = Array.from(
    new Set(
      raw.map((value) => {
        const id = normalizeString(value);
        if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) {
          throw new ApiError(
            "source_ids must contain datasource ids",
            400,
            "INVALID_SOURCE_IDS",
          );
        }
        return id;
      }),
    ),
  );
  if (ids.length > MAX_ADOPTION_SOURCES) {
    throw new ApiError(
      `An adoption can include at most ${MAX_ADOPTION_SOURCES} sources`,
      400,
      "TOO_MANY_SOURCE_IDS",
    );
  }
  return ids;
}

async function previewSourcesFromConfig(): Promise<ConfigSourcePreview[]> {
  const configPath = process.env.APP_CONFIG_PATH;
  if (!configPath) return [];

  const definitions = new Map<
    string,
    Pick<ConfigSourcePreview, "source_id" | "name" | "source_type">
  >();
  for (const sourceData of loadSeedConfig(configPath).rag_sources) {
    try {
      validateSourceSpecificInputFields(sourceData);
      const extracted = extractIngestionSourceTypeFields(sourceData);
      if (!extracted) continue;
      const sourceId = computeIngestionSourceId(extracted.identity);
      definitions.set(sourceId, {
        source_id: sourceId,
        name: normalizeString(sourceData.name) ?? sourceId,
        source_type: extracted.fields.source_type as IngestionSourceType,
      });
    } catch (error) {
      console.warn(
        `[rag-config-adoption] Skipping invalid source ${String(sourceData.name ?? "unknown")}:`,
        error,
      );
    }
  }
  if (definitions.size === 0) return [];

  const collection = await getCollection<IngestionSourceConfig>(
    "rag_ingestion_sources",
  );
  const existingDocs = await collection
    .find({ source_id: { $in: Array.from(definitions.keys()) } } as never)
    .project({
      source_id: 1,
      config_driven: 1,
      config_import_adopted: 1,
    })
    .toArray();
  const existingById = new Map(
    existingDocs.map((source) => [source.source_id, source]),
  );

  return Array.from(definitions.values()).map((definition) => {
    const existing = existingById.get(definition.source_id);
    const alreadyAdopted = existing?.config_import_adopted === true;
    const importable =
      existing?.config_driven === true && !alreadyAdopted;
    const unavailableReason: PreviewUnavailableReason | undefined = !existing
      ? "not_seeded"
      : !alreadyAdopted && existing.config_driven !== true
        ? "not_config_driven"
        : undefined;
    return {
      ...definition,
      in_db: Boolean(existing),
      already_adopted: alreadyAdopted,
      importable,
      ...(unavailableReason
        ? { unavailable_reason: unavailableReason }
        : {}),
    };
  });
}

async function loadAdoptionDestination(rawId: unknown): Promise<RagCollection> {
  const id = normalizeString(rawId) ?? PLATFORM_RAG_COLLECTION_ID;
  if (!RAG_COLLECTION_ID_PATTERN.test(id)) {
    throw new ApiError(
      "Destination collection id is invalid",
      400,
      "INVALID_DESTINATION_COLLECTION_ID",
    );
  }
  if (id === PLATFORM_RAG_COLLECTION_ID) {
    return bootstrapPlatformRagCollection();
  }
  const collections = await getCollection<RagCollection>(
    RAG_COLLECTIONS_COLLECTION,
  );
  const destination = await collections.findOne({ _id: id } as never);
  if (!destination) {
    throw new ApiError(
      "Destination collection not found",
      404,
      "DESTINATION_COLLECTION_NOT_FOUND",
    );
  }
  return destination;
}

function managementOwnerForCollection(collection: RagCollection): {
  ownerSubject: string | null;
  ownerTeamSlug: string | null;
} {
  const ownerTeamSlug = collection.maintainer_team_slugs?.[0] ?? null;
  const ownerSubject = ownerTeamSlug
    ? null
    : normalizeString(collection.owner_subject);
  if (!ownerTeamSlug && !ownerSubject) {
    throw new ApiError(
      "The destination collection needs an Owner before sources can be adopted",
      409,
      "DESTINATION_COLLECTION_HAS_NO_OWNER",
    );
  }
  return { ownerSubject, ownerTeamSlug };
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session, "admin_ui", "admin");
  await requireResourcePermission(session, {
    type: "organization",
    id: caipeOrgKey(),
    action: "manage",
  });

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

  const previews = await previewSourcesFromConfig();
  const destination = await loadAdoptionDestination(
    body.destination_collection_id,
  );
  if (body.dry_run !== false) {
    return successResponse<AdoptFromConfigResult>({
      sources: previews,
      configured_source_count: previews.length,
      destination_collection: {
        id: destination._id,
        source_count: destination.source_ids?.length ?? 0,
      },
    });
  }

  const requestedIds = Object.prototype.hasOwnProperty.call(body, "source_ids")
    ? parseSourceIds(body.source_ids)
    : previews.filter((source) => source.importable).map((source) => source.source_id);
  const previewById = new Map(previews.map((source) => [source.source_id, source]));
  const eligibleIds: string[] = [];
  const skipped: AdoptSkip[] = [];
  for (const sourceId of requestedIds) {
    const preview = previewById.get(sourceId);
    if (!preview) {
      skipped.push({ source_id: sourceId, reason: "not_in_config" });
    } else if (preview.already_adopted) {
      skipped.push({ source_id: sourceId, reason: "already_adopted" });
    } else if (!preview.in_db) {
      skipped.push({ source_id: sourceId, reason: "not_seeded" });
    } else if (!preview.importable) {
      skipped.push({ source_id: sourceId, reason: "not_config_driven" });
    } else {
      eligibleIds.push(sourceId);
    }
  }

  const managementOwner = managementOwnerForCollection(destination);
  const adoption = await adoptConfigImportedRagSources(
    eligibleIds,
    managementOwner,
  );
  skipped.push(...adoption.skipped);

  const destinationSources = Array.from(
    new Set([...(destination.source_ids ?? []), ...adoption.adopted]),
  );
  const updatedDestination =
    adoption.adopted.length > 0
      ? await replaceCollectionSources(destination._id, destinationSources)
      : destination;

  return successResponse<AdoptFromConfigResult>({
    sources: previews,
    adopted: adoption.adopted,
    skipped,
    configured_source_count: previews.length,
    destination_collection: {
      id: updatedDestination._id,
      source_count: updatedDestination.source_ids?.length ?? 0,
    },
  });
});
