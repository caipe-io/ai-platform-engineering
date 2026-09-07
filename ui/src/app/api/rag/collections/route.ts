import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import {
  RAG_COLLECTION_ID_PATTERN,
  RAG_COLLECTIONS_COLLECTION,
  removeRagCollectionFromAgentPins,
  reconcileCollectionRelationships,
} from "@/lib/rag-collections.server";
import {
  filterResourcesByPermission,
  requireResourcePermission,
} from "@/lib/rbac/resource-authz";
import { caipeOrgKey } from "@/lib/rbac/organization";
import { hasOrganizationAdmin } from "@/lib/rbac/platform-admin";
import type {
  RagCollection,
  RagCollectionWithPermissions,
} from "@/types/rag-collection";

const MAX_COLLECTIONS_PER_USER = 50;

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function collectionSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 128);
}

function requireSubject(session: { sub?: unknown }): string {
  const subject = normalizeString(session.sub);
  if (!subject)
    throw new ApiError("A stable user subject is required", 401, "NO_SUBJECT");
  return subject;
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  const collection = await getCollection<RagCollection>(
    RAG_COLLECTIONS_COLLECTION,
  );
  const candidates = await collection
    .find({})
    .sort({ is_platform: -1, name: 1 })
    .toArray();
  if (candidates.length === 0) return successResponse({ collections: [] });

  const [discoverable, readable, publishable, manageable] = await Promise.all([
    filterResourcesByPermission(
      session,
      candidates,
      { type: "rag_collection", action: "discover", id: (row) => row._id },
      { bypassForOrgAdmin: true },
    ),
    filterResourcesByPermission(
      session,
      candidates,
      { type: "rag_collection", action: "read", id: (row) => row._id },
      { bypassForOrgAdmin: true },
    ),
    filterResourcesByPermission(
      session,
      candidates,
      { type: "rag_collection", action: "write", id: (row) => row._id },
      { bypassForOrgAdmin: true },
    ),
    filterResourcesByPermission(
      session,
      candidates,
      { type: "rag_collection", action: "manage", id: (row) => row._id },
      { bypassForOrgAdmin: true },
    ),
  ]);
  const readableIds = new Set(readable.map((row) => row._id));
  const publishableIds = new Set(publishable.map((row) => row._id));
  const manageableIds = new Set(manageable.map((row) => row._id));
  const canDelegate = await hasOrganizationAdmin(session);
  const rows: RagCollectionWithPermissions[] = discoverable.map((row) => ({
    ...row,
    _permissions: {
      can_read: readableIds.has(row._id),
      can_publish: publishableIds.has(row._id) || manageableIds.has(row._id),
      can_manage: manageableIds.has(row._id),
      can_delegate: canDelegate,
    },
  }));
  return successResponse({ collections: rows });
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  if (session.isServiceAccount === true) {
    throw new ApiError(
      "Service accounts cannot create knowledge-base collections",
      403,
      "SERVICE_ACCOUNT_COLLECTION_MUTATION_FORBIDDEN",
    );
  }
  await requireResourcePermission(session, {
    type: "organization",
    id: caipeOrgKey(),
    action: "use",
  });
  const ownerSubject = requireSubject(session);
  const canDelegate = await hasOrganizationAdmin(session);
  const raw = await request.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("Request body must be an object", 400, "INVALID_BODY");
  }
  const body = raw as Record<string, unknown>;
  const name = normalizeString(body.name);
  if (!name || name.length > 80) {
    throw new ApiError(
      "name must be between 1 and 80 characters",
      400,
      "INVALID_NAME",
    );
  }
  const requestedId = normalizeString(body.id);
  const id = requestedId ?? collectionSlug(name);
  if (
    !id ||
    !RAG_COLLECTION_ID_PATTERN.test(id) ||
    id.toLowerCase() === "platform-rag"
  ) {
    throw new ApiError(
      "id is invalid or reserved",
      400,
      "INVALID_COLLECTION_ID",
    );
  }
  const description = normalizeString(body.description) ?? undefined;
  if (description && description.length > 500) {
    throw new ApiError(
      "description may not exceed 500 characters",
      400,
      "INVALID_DESCRIPTION",
    );
  }

  const collection = await getCollection<RagCollection>(
    RAG_COLLECTIONS_COLLECTION,
  );
  const ownedCount = await collection.countDocuments({
    owner_subject: ownerSubject,
  });
  if (ownedCount >= MAX_COLLECTIONS_PER_USER) {
    throw new ApiError(
      `You may own at most ${MAX_COLLECTIONS_PER_USER} knowledge bases`,
      409,
      "COLLECTION_LIMIT_REACHED",
    );
  }
  if (await collection.findOne({ _id: id } as never)) {
    throw new ApiError(
      "A knowledge base with this id already exists",
      409,
      "COLLECTION_EXISTS",
    );
  }

  // A prior delete may have removed the collection while its best-effort
  // agent cleanup was unavailable. The slug is safe to reuse only after every
  // stale agent reference is gone, otherwise the new collection would be
  // selected by agents that never opted into it.
  await removeRagCollectionFromAgentPins(id);

  const now = new Date().toISOString();
  const doc: RagCollection = {
    _id: id,
    name,
    description,
    is_platform: false,
    source_ids: [],
    owner_subject: ownerSubject,
    maintainer_team_slugs: [],
    reader_team_slugs: [],
    global_read: false,
    created_by: ownerSubject,
    created_at: now,
    updated_at: now,
  };
  try {
    await collection.insertOne(doc);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      throw new ApiError(
        "A knowledge base with this id already exists",
        409,
        "COLLECTION_EXISTS",
      );
    }
    throw error;
  }
  try {
    // Persist the document first so two concurrent creates cannot let the
    // losing request delete the winner's authorization tuples. Until the
    // relationship projection succeeds, the new row is fail-closed because
    // nobody has rag_collection#can_read.
    await reconcileCollectionRelationships(null, doc);
  } catch (error) {
    await collection
      .deleteOne({
        _id: id,
        owner_subject: ownerSubject,
        created_at: now,
      } as never)
      .catch((rollbackError) => {
        console.error(
          `[rag-collections] failed to roll back collection ${id} after policy failure`,
          rollbackError,
        );
      });
    throw error;
  }
  return successResponse<RagCollectionWithPermissions>(
    {
      ...doc,
      _permissions: {
        can_read: true,
        can_publish: true,
        can_manage: true,
        can_delegate: canDelegate,
      },
    },
    201,
  );
});
