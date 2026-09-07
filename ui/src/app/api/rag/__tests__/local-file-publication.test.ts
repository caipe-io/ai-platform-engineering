/** @jest-environment node */

import { NextRequest } from "next/server";

const mockCreatePublicationRequest = jest.fn();
const mockInvalidatePublicationRequests = jest.fn();
const mockPrepareRagPublication = jest.fn();
const mockReconcileSource = jest.fn();
const mockReconcileKnowledgeBase = jest.fn();
const mockReconcileDataSource = jest.fn();
const mockDeleteSource = jest.fn();
const mockDeleteKnowledgeBase = jest.fn();
const mockDeleteDataSource = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  const { ApiError } = jest.requireActual("@/lib/api-error");
  return {
    ApiError,
    getAuthFromBearerOrSession: jest.fn(async () => ({
      user: { email: "test-user@example.com" },
      session: {
        sub: "test-user-sub",
        role: "user",
        org: "example-org",
        accessToken: "browser-token",
        user: { email: "test-user@example.com", name: "Test User" },
      },
    })),
    requireRbacPermission: jest.fn(async () => undefined),
    handleApiError: (error: {
      message?: string;
      statusCode?: number;
      code?: string;
    }) =>
      Response.json(
        { error: error.message, code: error.code },
        { status: error.statusCode ?? 500 },
      ),
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: jest.fn(async (name: string) => {
    if (name !== "teams") throw new Error(`Unexpected collection ${name}`);
    return {
      find: jest.fn(() => ({
        project: jest.fn(() => ({
          toArray: jest.fn(async () => [{ slug: "everyone" }]),
        })),
      })),
    };
  }),
}));

jest.mock("@/lib/publication-approval.server", () => ({
  createPublicationRequest: (...args: unknown[]) =>
    mockCreatePublicationRequest(...args),
  invalidatePublicationRequests: (...args: unknown[]) =>
    mockInvalidatePublicationRequests(...args),
  publicationResourceRevision: jest.fn(() => "effective-revision"),
  recordAutoApprovedPublication: jest.fn(),
}));

jest.mock("@/lib/rag-publication-approval.server", () => ({
  prepareRagPublication: (...args: unknown[]) =>
    mockPrepareRagPublication(...args),
}));

jest.mock("@/lib/rag-ingestor-limits.server", () => ({
  enforceRagFileUploadLimits: jest.fn(),
  enforceRagIngestorLimits: jest.fn(),
  getRagIngestorLimits: jest.fn(async () => ({
    shared: { max_search_teams: 50 },
  })),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: jest.fn(async () => undefined),
  filterResourcesByPermission: jest.fn(
    async (_session, resources) => resources,
  ),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: jest.fn(async () => ({ allowed: false })),
}));

jest.mock("@/lib/rbac/organization", () => ({
  organizationObjectId: () => "organization:example-org",
}));

jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileIngestionSourceRelationships: (...args: unknown[]) =>
    mockReconcileSource(...args),
  reconcileKnowledgeBaseRelationships: (...args: unknown[]) =>
    mockReconcileKnowledgeBase(...args),
  reconcileDataSourceRelationships: (...args: unknown[]) =>
    mockReconcileDataSource(...args),
  reconcileMcpToolRelationships: jest.fn(),
  deleteAllIngestionSourceRelationshipTuples: (...args: unknown[]) =>
    mockDeleteSource(...args),
  deleteAllKnowledgeBaseRelationshipTuples: (...args: unknown[]) =>
    mockDeleteKnowledgeBase(...args),
  deleteAllDataSourceRelationshipTuples: (...args: unknown[]) =>
    mockDeleteDataSource(...args),
  deleteAllMcpToolRelationshipTuples: jest.fn(),
}));

jest.mock("@/lib/rag-collections.server", () => ({
  removeDatasourceFromAgentPins: jest.fn(),
  removeDatasourceFromRagCollections: jest.fn(),
  visibleRagCollectionsByDatasource: jest.fn(async () => new Map()),
}));

jest.mock("@/lib/rbac/shareable-resource", () => ({
  resolveShareableOwnershipWrite: jest.fn(),
}));

jest.mock("@/lib/rbac/user-identity-directory", () => ({
  resolveUserIdentitiesBySubject: jest.fn(async () => new Map()),
}));

const SOURCE_ID = "src_file_runbook_e12bb20996a5";

function uploadRequest(): NextRequest {
  const form = new FormData();
  form.append(
    "file",
    new File(["# hello"], "Runbook.md", { type: "text/markdown" }),
  );
  form.append("search_team_slugs", "everyone");
  return new NextRequest("http://localhost:3000/api/rag/v1/ingest/local-file", {
    method: "POST",
    body: form,
  });
}

describe("local-file publication approval", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReconcileSource.mockResolvedValue({ enabled: true });
    mockReconcileKnowledgeBase.mockResolvedValue({ enabled: true });
    mockReconcileDataSource.mockResolvedValue({ enabled: true });
    mockDeleteSource.mockResolvedValue({ enabled: true });
    mockDeleteKnowledgeBase.mockResolvedValue({ enabled: true });
    mockDeleteDataSource.mockResolvedValue({ enabled: true });
    mockInvalidatePublicationRequests.mockResolvedValue(1);
    mockPrepareRagPublication.mockImplementation(({ source }) => ({
      actor: {
        subject: "test-user-sub",
        email: "test-user@example.com",
        name: "Test User",
      },
      requesterTeamSlugs: [],
      requestedState: {
        search_team_slugs: ["everyone"],
        search_user_subjects: [],
      },
      plan: {
        requires_approval: true,
        reason: "Approval required: organization-wide audience.",
        effective_state: {
          search_team_slugs: [],
          search_user_subjects: [],
        },
        risk_facts: {
          organization_wide: true,
          added_team_slugs: ["everyone"],
          added_user_subjects: [],
        },
        approver_team_slugs: [],
      },
      resource: {
        kind: "rag_datasource",
        id: source.source_id,
        label: source.name,
      },
      resourceRevision: "ignored",
    }));
    mockCreatePublicationRequest.mockImplementation(async (input) => ({
      _id: "request-1",
      adapter_version: 1,
      resource: input.resource,
      authorization_policy_id: "publication.test.request-1",
      resource_revision: input.resourceRevision,
      requested_state: input.requestedState,
      effective_state: input.effectiveState,
      risk_facts: input.riskFacts,
      requester: input.requester,
      requester_team_slugs: [],
      approver_team_slugs: [],
      status: "pending",
      history: [],
      created_at: "2026-08-06T00:00:00.000Z",
      updated_at: "2026-08-06T00:00:00.000Z",
    }));
  });

  it("ingests immediately with only effective Search and queues the broader request", async () => {
    const forwardedForms: FormData[] = [];
    global.fetch = jest.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes(`/v1/datasource/${SOURCE_ID}/exists`)) {
        return Response.json({ datasource_id: SOURCE_ID, exists: false });
      }
      forwardedForms.push(init?.body as FormData);
      return Response.json(
        { datasource_id: SOURCE_ID, job_id: "job-1", message: "accepted" },
        { status: 202 },
      );
    }) as unknown as typeof fetch;

    const { POST } = await import("@/app/api/rag/[...path]/route");
    const response = await POST(uploadRequest(), {
      params: Promise.resolve({ path: ["v1", "ingest", "local-file"] }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      datasource_id: SOURCE_ID,
      _publication_request: { id: "request-1", status: "pending" },
    });
    expect(forwardedForms).toHaveLength(1);
    expect(forwardedForms[0].getAll("search_team_slugs")).toEqual([]);
    expect(forwardedForms[0].get("ownership_preprovisioned")).toBe("true");
    expect(forwardedForms[0].get("preprovisioned_datasource_id")).toBe(
      SOURCE_ID,
    );
    expect(mockReconcileKnowledgeBase).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: SOURCE_ID,
        nextSharedTeamSlugs: [],
      }),
    );
    expect(mockCreatePublicationRequest).toHaveBeenCalledTimes(1);
  });

  it("removes preprovisioned policy and supersedes the request when ingestion fails", async () => {
    global.fetch = jest.fn(async (url: string | URL) => {
      if (String(url).includes(`/v1/datasource/${SOURCE_ID}/exists`)) {
        return Response.json({ datasource_id: SOURCE_ID, exists: false });
      }
      return Response.json({ detail: "ingestor unavailable" }, { status: 503 });
    }) as unknown as typeof fetch;

    const { POST } = await import("@/app/api/rag/[...path]/route");
    const response = await POST(uploadRequest(), {
      params: Promise.resolve({ path: ["v1", "ingest", "local-file"] }),
    });

    expect(response.status).toBe(503);
    expect(mockDeleteSource).toHaveBeenCalledWith(SOURCE_ID);
    expect(mockDeleteKnowledgeBase).toHaveBeenCalledWith(SOURCE_ID);
    expect(mockDeleteDataSource).toHaveBeenCalledWith(SOURCE_ID);
    expect(mockInvalidatePublicationRequests).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rag_datasource", id: SOURCE_ID }),
      expect.objectContaining({ subject: "test-user-sub" }),
      expect.stringContaining("file upload failed"),
    );
  });
});
