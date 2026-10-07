const mockReconcileTupleDiff = jest.fn();
const mockReadOpenFgaTuples = jest.fn();
const mockGetUnlinkedServiceAccount = jest.fn();

jest.mock("@/lib/authz", () => ({
  reconcileTupleDiff: (...args: unknown[]) => mockReconcileTupleDiff(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  readOpenFgaTuples: (...args: unknown[]) => mockReadOpenFgaTuples(...args),
}));

jest.mock("@/lib/rbac/unlinked-service-account", () => ({
  getUnlinkedServiceAccount: (...args: unknown[]) =>
    mockGetUnlinkedServiceAccount(...args),
}));

import {
  reconcileExistingUnlinkedKnowledgeAccess,
  withUnlinkedEveryoneKnowledgeAccess,
} from "@/lib/rbac/unlinked-knowledge-access";
import type { OpenFgaTupleKey } from "@/lib/rbac/openfga";

const subject = "service_account:unlinked-subject";

function tuple(
  user: string,
  object: string,
  relation = "reader",
): { key: OpenFgaTupleKey } {
  return { key: { user, relation, object } };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUnlinkedServiceAccount.mockResolvedValue({
    sa_sub: "unlinked-subject",
    scopes_snapshot: [],
  });
  mockReadOpenFgaTuples.mockResolvedValue({
    tuples: [],
    continuationToken: undefined,
  });
  mockReconcileTupleDiff.mockImplementation(async (diff) => ({
    enabled: true,
    writes: diff.writes.length,
    deletes: diff.deletes.length,
  }));
});

describe("withUnlinkedEveryoneKnowledgeAccess", () => {
  it("adds datasource read and Search capability when Everyone becomes effective", async () => {
    const base = {
      writes: [
        {
          user: "team:everyone#member",
          relation: "reader",
          object: "knowledge_base:primary",
        },
      ],
      deletes: [],
    };

    await expect(
      withUnlinkedEveryoneKnowledgeAccess(
        {
          type: "datasource",
          id: "primary",
          previousEveryoneAccess: false,
          nextEveryoneAccess: true,
        },
        base,
      ),
    ).resolves.toEqual({
      writes: [
        ...base.writes,
        {
          user: subject,
          relation: "reader",
          object: "knowledge_base:primary",
        },
        {
          user: subject,
          relation: "searcher",
          object: "organization:caipe",
        },
      ],
      deletes: [],
    });
  });

  it("removes an automatic collection grant with approved Everyone removal", async () => {
    const result = await withUnlinkedEveryoneKnowledgeAccess(
      {
        type: "collection",
        id: "primary",
        previousEveryoneAccess: true,
        nextEveryoneAccess: false,
      },
      { writes: [], deletes: [] },
    );

    expect(result).toEqual({
      writes: [],
      deletes: [
        {
          user: subject,
          relation: "reader",
          object: "rag_collection:primary",
        },
      ],
    });
  });

  it("preserves a collection that was also granted explicitly", async () => {
    mockGetUnlinkedServiceAccount.mockResolvedValue({
      sa_sub: "unlinked-subject",
      scopes_snapshot: [
        {
          type: "collection",
          ref: "primary",
          added_by: "admin-subject",
          added_at: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
    });

    const result = await withUnlinkedEveryoneKnowledgeAccess(
      {
        type: "collection",
        id: "primary",
        previousEveryoneAccess: true,
        nextEveryoneAccess: false,
      },
      { writes: [], deletes: [] },
    );

    expect(result).toEqual({ writes: [], deletes: [] });
  });

  it("removes an automatic datasource tuple without touching its distinct explicit grant", async () => {
    mockGetUnlinkedServiceAccount.mockResolvedValue({
      sa_sub: "unlinked-subject",
      scopes_snapshot: [
        {
          type: "datasource",
          ref: "primary",
          added_by: "admin-subject",
          added_at: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
    });

    const result = await withUnlinkedEveryoneKnowledgeAccess(
      {
        type: "datasource",
        id: "primary",
        previousEveryoneAccess: true,
        nextEveryoneAccess: false,
      },
      { writes: [], deletes: [] },
    );

    expect(result).toEqual({
      writes: [],
      deletes: [
        {
          user: subject,
          relation: "reader",
          object: "knowledge_base:primary",
        },
      ],
    });
  });

  it("does not resolve the unlinked account for non-Everyone changes", async () => {
    const base = { writes: [], deletes: [] };
    await expect(
      withUnlinkedEveryoneKnowledgeAccess(
        {
          type: "datasource",
          id: "primary",
          previousEveryoneAccess: false,
          nextEveryoneAccess: false,
        },
        base,
      ),
    ).resolves.toBe(base);
    expect(mockGetUnlinkedServiceAccount).not.toHaveBeenCalled();
  });
});

describe("reconcileExistingUnlinkedKnowledgeAccess", () => {
  it("backfills effective Everyone access and removes stale automatic access", async () => {
    mockGetUnlinkedServiceAccount.mockResolvedValue({
      sa_sub: "unlinked-subject",
      scopes_snapshot: [
        {
          type: "collection",
          ref: "explicit-collection",
          added_by: "admin-subject",
          added_at: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
    });
    mockReadOpenFgaTuples.mockImplementation(
      async ({ tuple: filter }: { tuple: OpenFgaTupleKey }) => {
        const key = `${filter.user}|${filter.object}`;
        const rows: Record<string, Array<{ key: OpenFgaTupleKey }>> = {
          "team:everyone#member|knowledge_base:": [
            tuple("team:everyone#member", "knowledge_base:published-source"),
          ],
          "team:everyone#member|rag_collection:": [
            tuple("team:everyone#member", "rag_collection:published-collection"),
          ],
          [`${subject}|knowledge_base:`]: [
            tuple(subject, "knowledge_base:published-source"),
            tuple(subject, "knowledge_base:stale-source"),
          ],
          [`${subject}|data_source:`]: [],
          [`${subject}|rag_collection:`]: [
            tuple(subject, "rag_collection:published-collection"),
            tuple(subject, "rag_collection:explicit-collection"),
            tuple(subject, "rag_collection:stale-collection"),
          ],
        };
        return { tuples: rows[key] ?? [], continuationToken: undefined };
      },
    );

    await expect(reconcileExistingUnlinkedKnowledgeAccess()).resolves.toEqual({
      datasourceCount: 1,
      collectionCount: 1,
      writes: 4,
      deletes: 2,
    });
    expect(mockReconcileTupleDiff).toHaveBeenCalledWith(
      {
        writes: expect.arrayContaining([
          tuple(subject, "knowledge_base:published-source").key,
          tuple(subject, "rag_collection:published-collection").key,
          tuple(subject, "rag_collection:explicit-collection").key,
          {
            user: subject,
            relation: "searcher",
            object: "organization:caipe",
          },
        ]),
        deletes: expect.arrayContaining([
          tuple(subject, "knowledge_base:stale-source").key,
          tuple(subject, "rag_collection:stale-collection").key,
        ]),
      },
      { source: "unlinked_everyone_knowledge_reconcile" },
    );
  });

  it("keeps Search enabled for an authoritative explicit datasource grant", async () => {
    mockReadOpenFgaTuples.mockImplementation(
      async ({ tuple: filter }: { tuple: OpenFgaTupleKey }) => ({
        tuples:
          filter.user === subject && filter.object === "data_source:"
            ? [tuple(subject, "data_source:explicit-source")]
            : [],
        continuationToken: undefined,
      }),
    );

    await reconcileExistingUnlinkedKnowledgeAccess();

    expect(mockReconcileTupleDiff).toHaveBeenCalledWith(
      {
        writes: expect.arrayContaining([
          tuple(subject, "data_source:explicit-source").key,
          {
            user: subject,
            relation: "searcher",
            object: "organization:caipe",
          },
        ]),
        deletes: [],
      },
      { source: "unlinked_everyone_knowledge_reconcile" },
    );
  });
});
