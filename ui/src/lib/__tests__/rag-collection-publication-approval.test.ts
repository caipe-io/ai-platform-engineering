import {
  applyRagCollectionPublicationRequest,
  applyRagCollectionPublicationState,
  ragCollectionPublicationRevision,
  ragCollectionPublicationState,
} from "@/lib/rag-collection-publication-approval.server";
import type { PublicationRequestDocument } from "@/types/publication-approval";
import type { RagCollection } from "@/types/rag-collection";

const mockGetCollection = jest.fn();
const mockReconcileCollectionRelationships = jest.fn();
const mockEnsureReaderTeamsCanSearch = jest.fn();
const mockReplaceCollectionSources = jest.fn();
const mockDatasourceDependencyRevision = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/authz", () => ({
  reconcileTupleDiff: jest.fn(),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: jest.fn(),
  listOpenFgaObjects: jest.fn(),
  readOpenFgaTuples: jest.fn(),
}));

jest.mock("@/lib/rag-collections.server", () => ({
  RAG_COLLECTIONS_COLLECTION: "rag_collections",
  ragCollectionSetFields: (value: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(value).filter(
        ([key, fieldValue]) => key !== "_id" && fieldValue !== undefined,
      ),
    ),
  reconcileCollectionRelationships: (...args: unknown[]) =>
    mockReconcileCollectionRelationships(...args),
  ensureRagCollectionReaderTeamsCanSearch: (...args: unknown[]) =>
    mockEnsureReaderTeamsCanSearch(...args),
  replaceCollectionSources: (...args: unknown[]) =>
    mockReplaceCollectionSources(...args),
}));

jest.mock("@/lib/rag-publication-approval.server", () => ({
  ragDatasourcePublicationDependencyRevision: (...args: unknown[]) =>
    mockDatasourceDependencyRevision(...args),
}));

const currentCollection: RagCollection = {
  _id: "primary",
  name: "Primary knowledge",
  description: "Example collection",
  is_platform: false,
  source_ids: ["source-a"],
  maintainer_team_slugs: ["current-owner"],
  reader_team_slugs: ["search-team"],
  global_read: false,
  created_by: "creator-subject",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function requestFor(
  requestedState: Record<string, unknown>,
): PublicationRequestDocument {
  return {
    _id: "request-primary",
    adapter_version: 1,
    resource: {
      kind: "rag_collection",
      id: currentCollection._id,
      label: currentCollection.name,
    },
    authorization_policy_id:
      "publication.rag_collection.0123456789abcdef01234567.request-primary",
    resource_revision: ragCollectionPublicationRevision(
      currentCollection,
      ragCollectionPublicationState(currentCollection),
    ),
    requested_state: requestedState,
    effective_state: ragCollectionPublicationState(currentCollection) as unknown as Record<
      string,
      unknown
    >,
    risk_facts: {
      organization_wide: false,
      target_team_slugs: ["search-team"],
      reasons: ["collection ownership changed while Search is broadly shared"],
    },
    requester: { subject: "requester-subject" },
    requester_team_slugs: ["current-owner"],
    approver_team_slugs: ["approver-team"],
    status: "applying",
    history: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReconcileCollectionRelationships.mockResolvedValue(undefined);
  mockEnsureReaderTeamsCanSearch.mockResolvedValue(undefined);
  mockReplaceCollectionSources.mockImplementation(
    async (_id: string, sourceIds: string[]) => ({
      ...currentCollection,
      source_ids: sourceIds,
    }),
  );
  mockDatasourceDependencyRevision.mockImplementation(
    (source: { revision?: string }) => source.revision ?? "revision-current",
  );
});

describe("RAG collection publication application", () => {
  it("applies approved Owner teams and datasource membership together", async () => {
    const updateOne = jest
      .fn()
      .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    mockGetCollection.mockResolvedValue({ updateOne, replaceOne: jest.fn() });

    await applyRagCollectionPublicationState({
      previous: currentCollection,
      nextState: {
        maintainer_team_slugs: ["new-owner"],
        reader_team_slugs: ["search-team"],
        global_read: false,
        source_ids: ["source-a", "source-b"],
      },
      actorSubject: "approver-subject",
    });

    expect(mockReconcileCollectionRelationships).toHaveBeenCalledWith(
      currentCollection,
      expect.objectContaining({
        maintainer_team_slugs: ["new-owner"],
        reader_team_slugs: ["search-team"],
        source_ids: ["source-a"],
      }),
    );
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "primary" },
      expect.objectContaining({
        $set: expect.objectContaining({
          maintainer_team_slugs: ["new-owner"],
        }),
      }),
    );
    expect(mockEnsureReaderTeamsCanSearch).toHaveBeenCalledWith(
      ["search-team"],
      "approver-subject",
    );
    expect(mockReplaceCollectionSources).toHaveBeenCalledWith("primary", [
      "source-a",
      "source-b",
    ]);
  });

  it("rejects approval when a referenced datasource changed after review", async () => {
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "rag_collections") {
        return { findOne: jest.fn().mockResolvedValue(currentCollection) };
      }
      if (name === "rag_ingestion_sources") {
        return {
          find: jest.fn().mockReturnValue({
            toArray: jest
              .fn()
              .mockResolvedValue([{ source_id: "source-a", revision: "revision-new" }]),
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });

    const request = requestFor({
      ...ragCollectionPublicationState(currentCollection),
      source_dependency_revisions: { "source-a": "revision-reviewed" },
    });

    await expect(
      applyRagCollectionPublicationRequest(request, {
        sub: "approver-subject",
      }),
    ).rejects.toMatchObject({ code: "PUBLICATION_REVISION_CONFLICT" });
    expect(mockReconcileCollectionRelationships).not.toHaveBeenCalled();
  });

  it("applies an Owner change when collection and source revisions still match", async () => {
    const updateOne = jest
      .fn()
      .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "rag_collections") {
        return {
          findOne: jest.fn().mockResolvedValue(currentCollection),
          updateOne,
          replaceOne: jest.fn(),
        };
      }
      if (name === "rag_ingestion_sources") {
        return {
          find: jest.fn().mockReturnValue({
            toArray: jest
              .fn()
              .mockResolvedValue([{ source_id: "source-a", revision: "revision-current" }]),
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });

    const request = requestFor({
      ...ragCollectionPublicationState(currentCollection),
      maintainer_team_slugs: ["new-owner"],
      source_dependency_revisions: { "source-a": "revision-current" },
    });

    await applyRagCollectionPublicationRequest(request, {
      sub: "approver-subject",
    });

    expect(updateOne).toHaveBeenCalledWith(
      { _id: "primary" },
      expect.objectContaining({
        $set: expect.objectContaining({
          maintainer_team_slugs: ["new-owner"],
        }),
      }),
    );
  });
});
