/**
 * RAG collections are control-plane references: they grant read access and
 * expand to datasource IDs, but never copy chunks or grant ingestion/manage.
 */

const mockGetCollection = jest.fn();
const mockWriteOpenFgaTuples = jest.fn();
const mockFilterResourcesByPermission = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/authz", () => ({
  reconcileTupleDiff: (...args: unknown[]) => mockWriteOpenFgaTuples(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: jest.fn(),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  filterResourcesByPermission: (...args: unknown[]) =>
    mockFilterResourcesByPermission(...args),
}));

import {
  bootstrapPlatformRagCollection,
  collectionMembershipTuple,
  collectionRelationshipTuples,
  ensurePlatformRagCollection,
  manageableDatasourceIdsForCollectionPublishing,
  removeDatasourceFromAgentPins,
  removeRagCollectionFromAgentPins,
  replaceCollectionSources,
} from "@/lib/rag-collections.server";
import type { RagCollection } from "@/types/rag-collection";
import { PLATFORM_RAG_COLLECTION_ID } from "@/types/rag-collection";

const previous: RagCollection = {
  _id: "primary",
  name: "Primary knowledge",
  is_platform: false,
  source_ids: ["source-a", "source-b"],
  owner_subject: "owner-sub",
  maintainer_team_slugs: ["maintainers"],
  reader_team_slugs: ["readers"],
  global_read: false,
  created_by: "creator-sub",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteOpenFgaTuples.mockResolvedValue({ enabled: true });
  mockFilterResourcesByPermission.mockImplementation(
    async (_session, rows) => rows,
  );
});

describe("manageableDatasourceIdsForCollectionPublishing", () => {
  it("uses ingestion_source management for configured sources and data_source for legacy sources", async () => {
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        toArray: jest
          .fn()
          .mockResolvedValue([{ source_id: "source-configured" }]),
      }),
    });
    mockFilterResourcesByPermission.mockImplementation(
      async (_session, rows, target: { type: string }) =>
        target.type === "ingestion_source" ? rows : [],
    );

    const result = await manageableDatasourceIdsForCollectionPublishing(
      { sub: "test-user-subject" },
      ["source-configured", "source-legacy"],
    );

    expect(result).toEqual(new Set(["source-configured"]));
    expect(mockFilterResourcesByPermission).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      [{ source_id: "source-configured" }],
      expect.objectContaining({ type: "ingestion_source", action: "manage" }),
      { bypassForOrgAdmin: true },
    );
    expect(mockFilterResourcesByPermission).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      [{ source_id: "source-legacy" }],
      expect.objectContaining({ type: "data_source", action: "manage" }),
      { bypassForOrgAdmin: true },
    );
  });
});

describe("RAG collection tuple projection", () => {
  it("separates collection publishing, management, and readership", () => {
    const tuples = collectionRelationshipTuples(previous);

    expect(tuples).toEqual(
      expect.arrayContaining([
        {
          user: "user:creator-sub",
          relation: "creator",
          object: "rag_collection:primary",
        },
        {
          user: "user:owner-sub",
          relation: "owner",
          object: "rag_collection:primary",
        },
        {
          user: "user:owner-sub",
          relation: "reader",
          object: "rag_collection:primary",
        },
        {
          user: "team:maintainers#member",
          relation: "publisher",
          object: "rag_collection:primary",
        },
        {
          user: "team:maintainers#admin",
          relation: "manager",
          object: "rag_collection:primary",
        },
        {
          user: "team:readers#member",
          relation: "reader",
          object: "rag_collection:primary",
        },
      ]),
    );
    expect(tuples.some((tuple) => tuple.relation === "ingestor")).toBe(false);
    expect(
      tuples.some((tuple) => tuple.object.startsWith("knowledge_base:")),
    ).toBe(false);
  });

  it("projects membership as a read-only parent_collection edge", () => {
    expect(collectionMembershipTuple("primary", "source-a")).toEqual({
      user: "rag_collection:primary",
      relation: "parent_collection",
      object: "knowledge_base:source-a",
    });
  });
});

describe("replaceCollectionSources", () => {
  it("writes only the membership delta and persists the current IDs", async () => {
    const updateOne = jest
      .fn()
      .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(previous),
      updateOne,
    });

    const updated = await replaceCollectionSources("primary", [
      "source-b",
      "source-c",
    ]);

    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith(
      {
        writes: [collectionMembershipTuple("primary", "source-c")],
        deletes: [collectionMembershipTuple("primary", "source-a")],
      },
      { source: "rag_collection_membership" },
    );
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "primary" },
      {
        $set: expect.objectContaining({ source_ids: ["source-b", "source-c"] }),
      },
    );
    expect(updated.source_ids).toEqual(["source-b", "source-c"]);
  });

  it("restores the tuple projection when Mongo persistence fails", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(previous),
      updateOne: jest.fn().mockRejectedValue(new Error("database unavailable")),
    });

    await expect(
      replaceCollectionSources("primary", ["source-b", "source-c"]),
    ).rejects.toThrow("database unavailable");

    expect(mockWriteOpenFgaTuples).toHaveBeenNthCalledWith(
      1,
      {
        writes: [collectionMembershipTuple("primary", "source-c")],
        deletes: [collectionMembershipTuple("primary", "source-a")],
      },
      { source: "rag_collection_membership" },
    );
    expect(mockWriteOpenFgaTuples).toHaveBeenNthCalledWith(
      2,
      {
        writes: [collectionMembershipTuple("primary", "source-a")],
        deletes: [collectionMembershipTuple("primary", "source-c")],
      },
      { source: "rag_collection_membership_rollback" },
    );
  });
});

describe("ensurePlatformRagCollection", () => {
  it("merges legacy sources with manually maintained Platform membership", async () => {
    const platform = {
      ...previous,
      _id: "platform-rag",
      name: "Platform RAG",
      is_platform: true,
      source_ids: ["source-manual"],
    };
    const updateOne = jest
      .fn()
      .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(platform),
      updateOne,
      replaceOne: jest.fn(),
      deleteOne: jest.fn(),
    });

    const result = await ensurePlatformRagCollection({
      actorSubject: "admin-sub",
      maintainerTeamSlugs: ["maintainers"],
      readerTeamSlugs: ["readers"],
      sourceIds: ["source-legacy", "source-manual"],
      mergeSourceIds: true,
    });

    expect(result.source_ids).toEqual(["source-manual", "source-legacy"]);
    expect(mockWriteOpenFgaTuples).toHaveBeenLastCalledWith(
      {
        writes: [collectionMembershipTuple("platform-rag", "source-legacy")],
        deletes: [],
      },
      { source: "rag_collection_membership" },
    );
  });
});

describe("bootstrapPlatformRagCollection", () => {
  it("creates an empty collection for Super Admins and Everyone", async () => {
    let stored: RagCollection | null = null;
    const updateOne = jest.fn(
      async (
        filter: { _id: string },
        update: { $setOnInsert?: Record<string, unknown> },
      ) => {
        if (!stored) {
          stored = {
            _id: filter._id,
            ...(update.$setOnInsert ?? {}),
          } as RagCollection;
        }
        return { matchedCount: 0, upsertedCount: 1 };
      },
    );
    mockGetCollection.mockResolvedValue({
      updateOne,
      findOne: jest.fn(async () => stored),
    });

    const result = await bootstrapPlatformRagCollection();

    expect(result).toMatchObject({
      _id: PLATFORM_RAG_COLLECTION_ID,
      name: "Platform RAG",
      is_platform: true,
      source_ids: [],
      maintainer_team_slugs: ["super-admins"],
      reader_team_slugs: ["everyone"],
      global_read: false,
    });
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith(
      expect.objectContaining({
        writes: expect.arrayContaining([
          {
            user: "team:super-admins#admin",
            relation: "manager",
            object: "rag_collection:platform-rag",
          },
          {
            user: "team:everyone#member",
            relation: "reader",
            object: "rag_collection:platform-rag",
          },
        ]),
      }),
      { source: "rag_collection_relationships" },
    );
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith(
      {
        writes: [
          {
            user: "team:everyone#member",
            relation: "searcher",
            object: "organization:caipe",
          },
        ],
        deletes: [],
      },
      {
        caller: { type: "user", id: "platform" },
        source: "rag_collection_reader_search_capability",
      },
    );
  });

  it("preserves an existing Platform RAG configuration", async () => {
    const existing: RagCollection = {
      ...previous,
      _id: PLATFORM_RAG_COLLECTION_ID,
      name: "Company knowledge",
      is_platform: true,
      owner_subject: undefined,
      source_ids: ["source-custom"],
      maintainer_team_slugs: ["knowledge-maintainers"],
      reader_team_slugs: ["knowledge-readers"],
    };
    const updateOne = jest.fn().mockResolvedValue({
      matchedCount: 1,
      upsertedCount: 0,
    });
    mockGetCollection.mockResolvedValue({
      updateOne,
      findOne: jest.fn().mockResolvedValue(existing),
    });

    await expect(bootstrapPlatformRagCollection()).resolves.toBe(existing);

    expect(updateOne).toHaveBeenCalledWith(
      { _id: PLATFORM_RAG_COLLECTION_ID },
      { $setOnInsert: expect.objectContaining({ name: "Platform RAG" }) },
      { upsert: true },
    );
    expect(mockWriteOpenFgaTuples).toHaveBeenLastCalledWith(
      {
        writes: [
          {
            user: "team:knowledge-readers#member",
            relation: "searcher",
            object: "organization:caipe",
          },
        ],
        deletes: [],
      },
      {
        caller: { type: "user", id: "platform" },
        source: "rag_collection_reader_search_capability",
      },
    );
  });
});

describe("removeDatasourceFromAgentPins", () => {
  it("removes a retired deterministic datasource id from every explicit agent hand", async () => {
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 2 });
    mockGetCollection.mockResolvedValue({ updateMany });

    await expect(removeDatasourceFromAgentPins("source-a")).resolves.toBe(2);

    expect(mockGetCollection).toHaveBeenCalledWith("dynamic_agents");
    expect(updateMany).toHaveBeenCalledWith(
      { datasource_ids: "source-a" },
      {
        $pull: { datasource_ids: "source-a" },
        $set: { updated_at: expect.any(String) },
      },
    );
  });
});

describe("removeRagCollectionFromAgentPins", () => {
  it("removes a reusable collection slug from every old agent hand", async () => {
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 3 });
    mockGetCollection.mockResolvedValue({ updateMany });

    await expect(removeRagCollectionFromAgentPins("primary")).resolves.toBe(3);

    expect(mockGetCollection).toHaveBeenCalledWith("dynamic_agents");
    expect(updateMany).toHaveBeenCalledWith(
      { rag_collection_ids: "primary" },
      {
        $pull: { rag_collection_ids: "primary" },
        $set: { updated_at: expect.any(String) },
      },
    );
  });
});
