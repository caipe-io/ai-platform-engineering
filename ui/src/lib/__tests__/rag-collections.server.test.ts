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
  collectionMembershipTuple,
  collectionRelationshipTuples,
  searchableDatasourceIdsForCollectionPublishing,
  removeDatasourceFromAgentPins,
  removeRagCollectionFromAgentPins,
  replaceCollectionSources,
} from "@/lib/rag-collections.server";
import type { RagCollection } from "@/types/rag-collection";

const previous: RagCollection = {
  _id: "primary",
  name: "Primary knowledge",
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

describe("searchableDatasourceIdsForCollectionPublishing", () => {
  it("checks data_source#can_read uniformly, regardless of source-config rows", async () => {
    mockFilterResourcesByPermission.mockImplementation(
      async (_session, rows: { source_id: string }[]) =>
        rows.filter((row) => row.source_id === "source-readable"),
    );

    const result = await searchableDatasourceIdsForCollectionPublishing(
      { sub: "test-user-subject" },
      ["source-readable", "source-unreadable"],
    );

    expect(result).toEqual(new Set(["source-readable"]));
    expect(mockGetCollection).not.toHaveBeenCalled();
    expect(mockFilterResourcesByPermission).toHaveBeenCalledTimes(1);
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      expect.anything(),
      [{ source_id: "source-readable" }, { source_id: "source-unreadable" }],
      expect.objectContaining({ type: "data_source", action: "read" }),
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
