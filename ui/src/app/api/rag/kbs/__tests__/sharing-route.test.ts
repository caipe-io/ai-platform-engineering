/**
 * @jest-environment node
 */
/**
 * Integration tests for /api/rag/kbs/[id]/sharing.
 *
 * Covers the KB sharing route contract:
 * - GET/PUT accept either the query-policy grant or independent source
 *   management, and return/reconcile the canonical team slugs.
 * - Org admins are still bypassed via `bypassForOrgAdmin: true`.
 * - Invalid request bodies are rejected with 400.
 */

jest.mock("next-auth", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
}));

jest.mock("@/lib/api-middleware", () => {
  // Real ApiError so the route's `instanceof ApiError` matches errors thrown
  // by shared modules (shareable-resource.ts → @/lib/api-error). Production
  // api-middleware re-exports this same class.
  const { ApiError } = jest.requireActual("@/lib/api-error");
  return {
    ApiError,
    handleApiError: (error: unknown) =>
      Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "error",
          code: (error as { code?: string }).code,
        },
        { status: (error as { statusCode?: number }).statusCode ?? 500 },
      ),
  };
});

const mockExistingTeamSlugs = new Set<string>();
const mockGetCollection = jest.fn();
jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

const mockRequireResourcePermission = jest.fn();
const mockCanTransferResourceOwnership = jest.fn();
const mockFilterResourcesByPermission = jest.fn();
jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
  canTransferResourceOwnership: (...args: unknown[]) =>
    mockCanTransferResourceOwnership(...args),
  filterResourcesByPermission: (...args: unknown[]) =>
    mockFilterResourcesByPermission(...args),
}));

const mockReconcileKnowledgeBaseRelationships = jest.fn();
const mockReconcileDataSourceRelationships = jest.fn();
const mockReconcileIngestionSourceRelationships = jest.fn();
jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileIngestionSourceRelationships: (...args: unknown[]) =>
    mockReconcileIngestionSourceRelationships(...args),
  reconcileKnowledgeBaseRelationships: (...args: unknown[]) =>
    mockReconcileKnowledgeBaseRelationships(...args),
  reconcileDataSourceRelationships: (...args: unknown[]) =>
    mockReconcileDataSourceRelationships(...args),
}));

const mockReadOpenFgaTuples = jest.fn();
jest.mock("@/lib/rbac/openfga", () => ({
  readOpenFgaTuples: (...args: unknown[]) => mockReadOpenFgaTuples(...args),
  listOpenFgaObjects: jest.fn().mockResolvedValue({ objects: [] }),
  checkOpenFgaTuple: jest.fn().mockResolvedValue({ allowed: false }),
}));

jest.mock("@/lib/publication-approval-settings", () => {
  const actual = jest.requireActual("@/lib/publication-approval-settings");
  return {
    ...actual,
    getPublicationApprovalSettings: jest.fn(async () => ({
      ...actual.DEFAULT_PUBLICATION_APPROVAL_SETTINGS,
      require_rag_publication_approval: false,
    })),
  };
});

const mockResolveUserIdentitiesBySubject = jest.fn();
jest.mock("@/lib/rbac/user-identity-directory", () => ({
  resolveUserIdentitiesBySubject: (...args: unknown[]) =>
    mockResolveUserIdentitiesBySubject(...args),
  unresolvedUserIdentity: (subject: string) => ({
    subject,
    email: null,
    name: null,
    display_name: "Unknown user",
  }),
}));

import { getServerSession } from "next-auth";
import { NextRequest } from "next/server";
import { GET, PUT } from "@/app/api/rag/kbs/[id]/sharing/route";

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/rag/kbs/kb-1/sharing", {
    method: body === undefined ? "GET" : "PUT",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("/api/rag/kbs/[id]/sharing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExistingTeamSlugs.clear();
    for (const slug of [
      "legacy-team",
      "platform",
      "old-share",
      "data-eng",
      "ml-ops",
      "x",
    ]) {
      mockExistingTeamSlugs.add(slug);
    }
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
      insertOne: jest.fn().mockResolvedValue({ acknowledged: true }),
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
      find: (filter: { slug?: { $in?: string[] } }) => ({
        // RAG collection badge lookup consumes the cursor directly. This
        // sharing suite has no collection fixtures, so it returns no labels.
        toArray: async () => [],
        project: () => ({
          toArray: async () =>
            (filter.slug?.$in ?? [])
              .filter((slug) => mockExistingTeamSlugs.has(slug))
              .map((slug) => ({ slug })),
        }),
      }),
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
    });
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockCanTransferResourceOwnership.mockResolvedValue(true);
    mockFilterResourcesByPermission.mockImplementation(
      async (_session: unknown, resources: unknown[]) => resources,
    );
    mockReconcileKnowledgeBaseRelationships.mockResolvedValue({
      enabled: true,
      writes: 2,
      deletes: 0,
    });
    mockReconcileIngestionSourceRelationships.mockResolvedValue({
      enabled: true,
      writes: 2,
      deletes: 0,
    });
    mockReconcileDataSourceRelationships.mockResolvedValue({
      enabled: true,
      writes: 1,
      deletes: 0,
    });
    mockReadOpenFgaTuples.mockResolvedValue({ tuples: [] });
    mockResolveUserIdentitiesBySubject.mockImplementation(
      async (subjects: string[]) =>
        new Map(
          subjects.map((subject) => [
            subject,
            {
              subject,
              email: `${subject}@example.com`,
              name: subject === "alice-sub" ? "Test User" : "Example Reader",
              display_name: `${subject}@example.com`,
            },
          ]),
        ),
    );
    (getServerSession as jest.Mock).mockResolvedValue({
      accessToken: "tok",
      sub: "alice-sub",
      org: "caipe",
      user: { email: "alice@example.com" },
    });
  });

  describe("GET", () => {
    it("returns 401 when no session", async () => {
      (getServerSession as jest.Mock).mockResolvedValue(null);
      const res = await GET(makeRequest(), {
        params: Promise.resolve({ id: "kb-1" }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects invalid kb id", async () => {
      const res = await GET(makeRequest(), {
        params: Promise.resolve({ id: "..bad..!" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("INVALID_KB_ID");
    });

    it("returns canonical shared team slugs from OpenFGA reader tuples", async () => {
      mockReadOpenFgaTuples.mockResolvedValueOnce({
        tuples: [
          {
            key: {
              user: "team:platform#member",
              relation: "reader",
              object: "knowledge_base:kb-1",
            },
          },
          {
            key: {
              user: "team:data-eng#member",
              relation: "reader",
              object: "knowledge_base:kb-1",
            },
          },
          {
            key: {
              user: "team:platform#admin",
              relation: "manager",
              object: "knowledge_base:kb-1",
            },
          },
          {
            key: {
              user: "user:alice-sub",
              relation: "owner",
              object: "knowledge_base:kb-1",
            },
          },
        ],
      });

      const res = await GET(makeRequest(), {
        params: Promise.resolve({ id: "kb-1" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.knowledge_base_id).toBe("kb-1");
      expect(body.shared_team_slugs).toEqual(["data-eng", "platform"]);
      expect(mockRequireResourcePermission).toHaveBeenCalledWith(
        expect.objectContaining({ sub: "alice-sub" }),
        { type: "ingestion_source", id: "kb-1", action: "read" },
        { bypassForOrgAdmin: true },
      );
    });

    it("returns the real owner_team_slug + creator_subject from the datasource config", async () => {
      // OpenFGA reader tuples include the owner team (platform) + a shared team.
      mockReadOpenFgaTuples.mockResolvedValueOnce({
        tuples: [
          {
            key: {
              user: "team:platform#member",
              relation: "reader",
              object: "knowledge_base:kb-1",
            },
          },
          {
            key: {
              user: "team:data-eng#member",
              relation: "reader",
              object: "knowledge_base:kb-1",
            },
          },
        ],
      });
      // The datasource config (RAG server) is the source of truth for owner.
      const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            datasources: [
              {
                datasource_id: "kb-1",
                owner_team_slug: "platform",
                creator_subject: "alice-sub",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const res = await GET(makeRequest(), {
        params: Promise.resolve({ id: "kb-1" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.owner_team_slug).toBe("platform");
      expect(body.creator_subject).toBe("alice-sub");
      // Owner Team and Search Access are independent; the same team may be in
      // both controls and must remain visible in the search-team list.
      expect(body.shared_team_slugs).toEqual(["data-eng", "platform"]);
      fetchSpy.mockRestore();
    });

    it("lets an independent source reader inspect Search sharing", async () => {
      const ApiErrorClass = jest.requireMock("@/lib/api-middleware").ApiError;
      mockRequireResourcePermission.mockImplementation(
        async (_session: unknown, target: { type: string }) => {
          if (target.type === "knowledge_base") {
            throw new ApiErrorClass("no content read", 403, "FORBIDDEN");
          }
        },
      );
      const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            datasources: [
              { datasource_id: "kb-1", owner_team_slug: "platform" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const res = await GET(makeRequest(), {
        params: Promise.resolve({ id: "kb-1" }),
      });

      expect(res.status).toBe(200);
      expect(mockRequireResourcePermission).toHaveBeenCalledWith(
        expect.objectContaining({ sub: "alice-sub" }),
        { type: "ingestion_source", id: "kb-1", action: "read" },
        { bypassForOrgAdmin: true },
      );
      fetchSpy.mockRestore();
    });
  });

  describe("PUT", () => {
    it("normalizes input and forwards previous + next slugs to the reconciler", async () => {
      mockReadOpenFgaTuples.mockResolvedValueOnce({
        tuples: [
          {
            key: {
              user: "team:legacy-team#member",
              relation: "reader",
              object: "knowledge_base:kb-1",
            },
          },
          {
            key: {
              user: "team:legacy-team#admin",
              relation: "manager",
              object: "knowledge_base:kb-1",
            },
          },
        ],
      });
      // No owner persisted in config (pre-migration datasource).
      const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({ datasources: [{ datasource_id: "kb-1" }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

      const res = await PUT(
        makeRequest({ team_slugs: [" data-eng ", "ml-ops", "data-eng"] }),
        { params: Promise.resolve({ id: "kb-1" }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.shared_team_slugs).toEqual(["data-eng", "ml-ops"]);

      expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledWith(
        expect.objectContaining({
          knowledgeBaseId: "kb-1",
          ownerTeamSlug: null,
          nextSharedTeamSlugs: ["data-eng", "ml-ops"],
          previousSharedTeamSlugs: ["legacy-team"],
        }),
      );

      // The data_source inherits the KB grants via the `parent_kb` edge
      // (spec 2026-06-03, US4) — sharing the KB ensures that single
      // inheritance edge exists rather than mirroring per-team tuples.
      expect(mockReconcileDataSourceRelationships).toHaveBeenCalledWith(
        expect.objectContaining({
          dataSourceId: "kb-1",
          parentKnowledgeBaseId: "kb-1",
        }),
      );

      expect(mockRequireResourcePermission).toHaveBeenCalledWith(
        expect.objectContaining({ sub: "alice-sub" }),
        { type: "ingestion_source", id: "kb-1", action: "manage" },
        { bypassForOrgAdmin: true },
      );
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/v1/datasource/kb-1/owner-team"),
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            owner_team_slug: null,
            owner_subject: "alice-sub",
            search_with_teams: ["data-eng", "ml-ops"],
            search_with_users: [],
          }),
        }),
      );
      fetchSpy.mockRestore();
    });

    it("reconciles direct-user Search grants without granting source management", async () => {
      const fetchSpy = jest
        .spyOn(global, "fetch")
        .mockImplementation((url: string | URL) => {
          if (String(url).endsWith("/v1/datasources")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  datasources: [
                    {
                      datasource_id: "kb-1",
                      owner_team_slug: "platform",
                      creator_subject: "alice-sub",
                    },
                  ],
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              ),
            );
          }
          return Promise.resolve(new Response(null, { status: 200 }));
        });

      const res = await PUT(
        makeRequest({
          owner: { kind: "team", id: "platform" },
          search_access: [
            { kind: "team", id: "data-eng" },
            { kind: "user", id: "reader-sub" },
          ],
        }),
        { params: Promise.resolve({ id: "kb-1" }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.shared_user_subjects).toEqual(["reader-sub"]);
      expect(body.search_access).toContainEqual(
        expect.objectContaining({
          kind: "user",
          id: "reader-sub",
          name: "Example Reader",
        }),
      );
      expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledWith(
        expect.objectContaining({
          nextSharedTeamSlugs: ["data-eng"],
          nextSharedUserSubjects: ["reader-sub"],
        }),
      );
      expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
        expect.objectContaining({ nextSharedTeamSlugs: [] }),
      );
      fetchSpy.mockRestore();
    });

    it("allows the management owner team to also have explicit Search Access", async () => {
      // OpenFGA reader tuples include an explicit Search Access grant for the
      // management owner team plus another team being removed in this update.
      mockReadOpenFgaTuples.mockResolvedValueOnce({
        tuples: [
          {
            key: {
              user: "team:platform#member",
              relation: "reader",
              object: "knowledge_base:kb-1",
            },
          },
          {
            key: {
              user: "team:old-share#member",
              relation: "reader",
              object: "knowledge_base:kb-1",
            },
          },
        ],
      });
      // Config (source of truth) says platform is the owner team.
      const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            datasources: [
              { datasource_id: "kb-1", owner_team_slug: "platform" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      // Caller shares with data-eng and (redundantly) lists the owner team.
      const res = await PUT(
        makeRequest({ team_slugs: ["data-eng", "platform"] }),
        { params: Promise.resolve({ id: "kb-1" }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.shared_team_slugs).toEqual(["data-eng", "platform"]);

      // KB ownership stays null. Platform remains solely because it is in the
      // explicit Search Access set; old-share is revoked.
      expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledWith(
        expect.objectContaining({
          knowledgeBaseId: "kb-1",
          ownerTeamSlug: null,
          previousOwnerTeamSlug: "platform",
          nextSharedTeamSlugs: ["data-eng", "platform"],
          previousSharedTeamSlugs: ["old-share", "platform"],
        }),
      );
      fetchSpy.mockRestore();
    });

    it("rejects malformed JSON bodies", async () => {
      const req = new NextRequest("http://localhost/api/rag/kbs/kb-1/sharing", {
        method: "PUT",
        body: "not json",
        headers: { "content-type": "application/json" },
      });
      const res = await PUT(req, { params: Promise.resolve({ id: "kb-1" }) });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("INVALID_JSON");
    });

    it("rejects array body (must be object with team_slugs)", async () => {
      const res = await PUT(makeRequest(["x"]), {
        params: Promise.resolve({ id: "kb-1" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects when caller lacks both source management and legacy KB admin", async () => {
      const ApiErrorClass = jest.requireMock("@/lib/api-middleware").ApiError;
      mockRequireResourcePermission.mockRejectedValue(
        new ApiErrorClass("forbidden", 403, "FORBIDDEN"),
      );
      const res = await PUT(makeRequest({ team_slugs: ["x"] }), {
        params: Promise.resolve({ id: "kb-1" }),
      });
      expect(res.status).toBe(403);
      expect(mockRequireResourcePermission).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ sub: "alice-sub" }),
        { type: "ingestion_source", id: "kb-1", action: "manage" },
        { bypassForOrgAdmin: true },
      );
      expect(mockRequireResourcePermission).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ sub: "alice-sub" }),
        { type: "knowledge_base", id: "kb-1", action: "admin" },
        { bypassForOrgAdmin: true },
      );
    });

    it("lets an independent source manager update Search sharing", async () => {
      const ApiErrorClass = jest.requireMock("@/lib/api-middleware").ApiError;
      mockRequireResourcePermission.mockImplementation(
        async (_session: unknown, target: { type: string }) => {
          if (target.type === "knowledge_base") {
            throw new ApiErrorClass("no query admin", 403, "FORBIDDEN");
          }
        },
      );
      const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            datasources: [
              { datasource_id: "kb-1", owner_team_slug: "platform" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const res = await PUT(makeRequest({ team_slugs: ["data-eng"] }), {
        params: Promise.resolve({ id: "kb-1" }),
      });

      expect(res.status).toBe(200);
      expect(mockRequireResourcePermission).toHaveBeenCalledWith(
        expect.objectContaining({ sub: "alice-sub" }),
        { type: "ingestion_source", id: "kb-1", action: "manage" },
        { bypassForOrgAdmin: true },
      );
      expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledWith(
        expect.objectContaining({
          knowledgeBaseId: "kb-1",
          nextSharedTeamSlugs: ["data-eng"],
        }),
      );
      fetchSpy.mockRestore();
    });

    describe("ownership transfer (US3)", () => {
      // Mock the RAG server: GET /v1/datasources returns the current config
      // (owner = platform); PATCH /owner-team is the narrow owner update.
      function mockRagConfig(currentOwner: string) {
        return jest
          .spyOn(global, "fetch")
          .mockImplementation((url: string | URL) => {
            const u = String(url);
            if (u.endsWith("/v1/datasources")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    datasources: [
                      {
                        datasource_id: "kb-1",
                        owner_team_slug: currentOwner,
                        creator_subject: "alice-sub",
                      },
                    ],
                  }),
                  {
                    status: 200,
                    headers: { "content-type": "application/json" },
                  },
                ),
              );
            }
            // PATCH /v1/datasource/kb-1/owner-team → 200.
            return Promise.resolve(new Response(null, { status: 200 }));
          });
      }

      it("transfers ownership to a new team when authorized, persisting + revoking the old owner", async () => {
        mockReadOpenFgaTuples.mockResolvedValue({ tuples: [] });
        mockCanTransferResourceOwnership.mockResolvedValue(true);
        mockRequireResourcePermission.mockResolvedValue(undefined); // member of destination
        const fetchSpy = mockRagConfig("platform");

        const res = await PUT(
          makeRequest({ owner_team_slug: "data-eng", team_slugs: [] }),
          { params: Promise.resolve({ id: "kb-1" }) },
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.owner_team_slug).toBe("data-eng");
        expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceId: "kb-1",
            ownerTeamSlug: "data-eng",
            previousOwnerTeamSlug: "platform",
          }),
        );
        // The KB graph has no management owner. The old coupled owner tuple is
        // removed while no Search Access teams are selected.
        expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledWith(
          expect.objectContaining({
            knowledgeBaseId: "kb-1",
            ownerTeamSlug: null,
            previousOwnerTeamSlug: "platform",
            nextSharedTeamSlugs: [],
          }),
        );
        // Management ownership and Search Access metadata are persisted
        // together through the narrow access-policy endpoint.
        expect(fetchSpy).toHaveBeenCalledWith(
          expect.stringContaining("/v1/datasource/kb-1/owner-team"),
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({
              owner_team_slug: "data-eng",
              owner_subject: null,
              search_with_teams: [],
              search_with_users: [],
            }),
          }),
        );
        const ownerPersistCall = fetchSpy.mock.calls.findIndex(([url]) =>
          String(url).includes("/owner-team"),
        );
        expect(ownerPersistCall).toBeGreaterThanOrEqual(0);
        expect(
          fetchSpy.mock.invocationCallOrder[ownerPersistCall],
        ).toBeLessThan(
          mockReconcileKnowledgeBaseRelationships.mock.invocationCallOrder[0],
        );
        fetchSpy.mockRestore();
      });

      it("uses ingestion_source management as the transfer guard for a source manager", async () => {
        mockReadOpenFgaTuples.mockResolvedValue({ tuples: [] });
        const ApiErrorClass = jest.requireMock("@/lib/api-middleware").ApiError;
        mockRequireResourcePermission.mockImplementation(
          async (_session: unknown, target: { type: string }) => {
            if (target.type === "knowledge_base") {
              throw new ApiErrorClass("no query admin", 403, "FORBIDDEN");
            }
          },
        );
        mockCanTransferResourceOwnership.mockResolvedValue(true);
        const fetchSpy = mockRagConfig("platform");

        const res = await PUT(
          makeRequest({ owner_team_slug: "data-eng", team_slugs: [] }),
          { params: Promise.resolve({ id: "kb-1" }) },
        );

        expect(res.status).toBe(200);
        expect(mockCanTransferResourceOwnership).toHaveBeenCalledWith(
          expect.objectContaining({ sub: "alice-sub" }),
          { type: "ingestion_source", id: "kb-1" },
        );
        fetchSpy.mockRestore();
      });

      it("keeps the old policy intact when owner persistence fails", async () => {
        mockReadOpenFgaTuples.mockResolvedValue({ tuples: [] });
        mockCanTransferResourceOwnership.mockResolvedValue(true);
        mockRequireResourcePermission.mockResolvedValue(undefined);
        const fetchSpy = jest
          .spyOn(global, "fetch")
          .mockImplementation((url: string | URL) => {
            if (String(url).endsWith("/v1/datasources")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    datasources: [
                      {
                        datasource_id: "kb-1",
                        owner_team_slug: "platform",
                        creator_subject: "alice-sub",
                      },
                    ],
                  }),
                  {
                    status: 200,
                    headers: { "content-type": "application/json" },
                  },
                ),
              );
            }
            return Promise.resolve(new Response(null, { status: 503 }));
          });

        const res = await PUT(
          makeRequest({ owner_team_slug: "data-eng", team_slugs: [] }),
          { params: Promise.resolve({ id: "kb-1" }) },
        );

        expect(res.status).toBe(502);
        expect(mockReconcileKnowledgeBaseRelationships).not.toHaveBeenCalled();
        expect(mockReconcileDataSourceRelationships).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
      });

      it("restores owner metadata and the old policy when reconciliation fails", async () => {
        mockReadOpenFgaTuples.mockResolvedValue({ tuples: [] });
        mockCanTransferResourceOwnership.mockResolvedValue(true);
        mockRequireResourcePermission.mockResolvedValue(undefined);
        mockReconcileKnowledgeBaseRelationships
          .mockRejectedValueOnce(new Error("authorization service unavailable"))
          .mockResolvedValueOnce({ enabled: true, writes: 4, deletes: 4 });
        const fetchSpy = mockRagConfig("platform");

        const res = await PUT(
          makeRequest({ owner_team_slug: "data-eng", team_slugs: ["ml-ops"] }),
          { params: Promise.resolve({ id: "kb-1" }) },
        );

        expect(res.status).toBe(500);
        expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledTimes(
          2,
        );
        expect(
          mockReconcileKnowledgeBaseRelationships,
        ).toHaveBeenLastCalledWith(
          expect.objectContaining({
            knowledgeBaseId: "kb-1",
            ownerTeamSlug: null,
            previousOwnerTeamSlug: "data-eng",
            nextSharedTeamSlugs: [],
            previousSharedTeamSlugs: ["ml-ops"],
          }),
        );
        const ownerBodies = fetchSpy.mock.calls
          .filter(([url]) => String(url).includes("/owner-team"))
          .map(([, init]) => JSON.parse(String(init?.body)));
        expect(ownerBodies).toEqual([
          {
            owner_team_slug: "data-eng",
            owner_subject: null,
            search_with_teams: ["ml-ops"],
            search_with_users: [],
          },
          {
            owner_team_slug: "platform",
            owner_subject: null,
            search_with_teams: [],
            search_with_users: [],
          },
        ]);
        fetchSpy.mockRestore();
      });

      it("denies a transfer when the caller is neither owner-team admin nor org admin", async () => {
        mockReadOpenFgaTuples.mockResolvedValue({ tuples: [] });
        mockCanTransferResourceOwnership.mockResolvedValue(false);
        const fetchSpy = mockRagConfig("platform");

        const res = await PUT(
          makeRequest({ owner_team_slug: "data-eng", team_slugs: [] }),
          { params: Promise.resolve({ id: "kb-1" }) },
        );
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.code).toBe("TRANSFER_FORBIDDEN");
        fetchSpy.mockRestore();
      });

      it("requires not-a-member confirmation for a transfer to a team the caller isn't in", async () => {
        mockReadOpenFgaTuples.mockResolvedValue({ tuples: [] });
        mockCanTransferResourceOwnership.mockResolvedValue(true);
        // Not a member of the destination team.
        const ApiErrorClass = jest.requireMock("@/lib/api-middleware").ApiError;
        mockRequireResourcePermission.mockImplementation(
          async (_s: unknown, t: { type: string }) => {
            if (t.type === "team") throw new ApiErrorClass("not a member", 403);
          },
        );
        const fetchSpy = mockRagConfig("platform");

        const res = await PUT(
          makeRequest({ owner_team_slug: "data-eng", team_slugs: [] }),
          { params: Promise.resolve({ id: "kb-1" }) },
        );
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.code).toBe("TRANSFER_NOT_MEMBER_UNCONFIRMED");
        fetchSpy.mockRestore();
      });
    });
  });
});
