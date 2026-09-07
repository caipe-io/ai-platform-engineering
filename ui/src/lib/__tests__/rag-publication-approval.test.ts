import {
  applyRagPublicationRequest,
  changedApprovalGatedSourceUpdate,
} from "@/lib/rag-publication-approval.server";
import { publicationResourceRevision } from "@/lib/publication-approval.server";
import type { IngestionSourceConfig } from "@/types/ingestion-source";
import type { PublicationRequestDocument } from "@/types/publication-approval";

const mockGetCollection = jest.fn();
const mockReadOpenFgaTuples = jest.fn();
const mockReconcileIngestionSourceRelationships = jest.fn();
const mockReconcileKnowledgeBaseRelationships = jest.fn();
const mockReconcileDataSourceRelationships = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  readOpenFgaTuples: (...args: unknown[]) => mockReadOpenFgaTuples(...args),
}));

jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileIngestionSourceRelationships: (...args: unknown[]) =>
    mockReconcileIngestionSourceRelationships(...args),
  reconcileKnowledgeBaseRelationships: (...args: unknown[]) =>
    mockReconcileKnowledgeBaseRelationships(...args),
  reconcileDataSourceRelationships: (...args: unknown[]) =>
    mockReconcileDataSourceRelationships(...args),
}));

function response(
  status: number,
  payload: Record<string, unknown> | null = null,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(payload),
    text: jest.fn().mockResolvedValue(payload ? JSON.stringify(payload) : ""),
  } as unknown as Response;
}

function request(ownerSubject: string): PublicationRequestDocument {
  const effectiveState = {
    search_team_slugs: [],
    search_user_subjects: [],
  };
  return {
    _id: "request-primary",
    adapter_version: 1,
    resource: {
      kind: "rag_datasource",
      id: "source-primary",
      label: "Primary source",
    },
    authorization_policy_id:
      "publication.rag_datasource.0123456789abcdef01234567.request-primary",
    resource_revision: publicationResourceRevision({
      source_id: "source-primary",
      owner_team_slug: null,
      owner_subject: ownerSubject,
      creator_subject: "creator-subject",
      ...effectiveState,
    }),
    requested_state: {
      search_team_slugs: ["reader-team"],
      search_user_subjects: [],
    },
    effective_state: effectiveState,
    risk_facts: {
      organization_wide: false,
      target_team_slugs: ["reader-team"],
      reasons: ["new team audience"],
    },
    requester: {
      subject: "requester-subject",
      email: "requester@example.com",
    },
    requester_team_slugs: ["owner-team"],
    approver_team_slugs: ["approver-team"],
    status: "applying",
    history: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCollection.mockResolvedValue({
    findOne: jest.fn().mockResolvedValue(null),
  });
  mockReadOpenFgaTuples.mockResolvedValue({ tuples: [] });
  mockReconcileKnowledgeBaseRelationships.mockResolvedValue({
    enabled: true,
    writes: 1,
    deletes: 0,
  });
  mockReconcileIngestionSourceRelationships.mockResolvedValue({
    enabled: true,
    writes: 1,
    deletes: 1,
  });
  mockReconcileDataSourceRelationships.mockResolvedValue({
    enabled: true,
    writes: 1,
    deletes: 0,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("legacy RAG publication approval", () => {
  it("validates the narrow ownership projection before applying Search", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        response(200, {
          datasource_id: "source-primary",
          owner_team_slug: null,
          owner_subject: "owner-subject",
          creator_subject: "creator-subject",
        }),
      )
      .mockResolvedValueOnce(response(200, { changed: true }));

    await applyRagPublicationRequest(request("owner-subject"), "access-token");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/v1/datasource/source-primary/publication-state"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
          "X-Publication-Authorization-Id": expect.stringContaining(
            "publication.rag_datasource.",
          ),
        }),
      }),
    );
    expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        creatorSubject: "creator-subject",
        ownerSubject: "owner-subject",
        nextSharedTeamSlugs: ["reader-team"],
      }),
    );
  });

  it("requires a new review if the Owner changed after submission", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(
      response(200, {
        datasource_id: "source-primary",
        owner_team_slug: null,
        owner_subject: "different-owner",
        creator_subject: "creator-subject",
      }),
    );

    await expect(
      applyRagPublicationRequest(request("owner-subject"), "access-token"),
    ).rejects.toMatchObject({ code: "PUBLICATION_REVISION_CONFLICT" });
    expect(mockReconcileKnowledgeBaseRelationships).not.toHaveBeenCalled();
  });

  it("does not apply an approval after the legacy datasource is deleted", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(response(404));

    await expect(
      applyRagPublicationRequest(request("owner-subject"), "access-token"),
    ).rejects.toMatchObject({ code: "PUBLICATION_REVISION_CONFLICT" });
    expect(mockReconcileKnowledgeBaseRelationships).not.toHaveBeenCalled();
  });

  it("applies an approved Owner transfer with the request-scoped capability", async () => {
    const publicationRequest = request("owner-subject");
    publicationRequest.requested_state = {
      ...publicationRequest.requested_state,
      owner_update: {
        owner_team_slug: "owner-team",
        owner_subject: null,
      },
    };
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        response(200, {
          datasource_id: "source-primary",
          owner_team_slug: null,
          owner_subject: "owner-subject",
          creator_subject: "creator-subject",
        }),
      )
      .mockResolvedValueOnce(response(200, { changed: true }));

    await applyRagPublicationRequest(publicationRequest, "access-token");

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/v1/datasource/source-primary/owner-team"),
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          "X-Publication-Authorization-Id":
            publicationRequest.authorization_policy_id,
        }),
        body: JSON.stringify({
          owner_team_slug: "owner-team",
          owner_subject: null,
          search_with_teams: ["reader-team"],
          search_with_users: [],
        }),
      }),
    );
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "source-primary",
        ownerSubject: null,
        previousOwnerSubject: "owner-subject",
        ownerTeamSlug: "owner-team",
        previousOwnerTeamSlug: null,
      }),
    );
    expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerSubject: null,
        previousOwnerSubject: "owner-subject",
      }),
    );
  });
});

describe("datasource publication change detection", () => {
  const confluenceSource: IngestionSourceConfig = {
    source_id: "confluence-example-P1",
    source_type: "confluence_space",
    name: "Example page",
    description: "",
    status: "active",
    default_chunk_size: 10000,
    default_chunk_overlap: 2000,
    reload_interval: 86400,
    config_driven: false,
    config_import_adopted: false,
    visibility: "team",
    shared_with_teams: [],
    confluence_url: "https://example.atlassian.net",
    space_key: "EXAMPLE",
    start_page_url: "https://example.atlassian.net/wiki/spaces/EXAMPLE/pages/1/Page",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  it("ignores unchanged connector defaults sent by the edit form", () => {
    expect(changedApprovalGatedSourceUpdate(confluenceSource, {
      get_child_pages: false,
      allowed_title_patterns: [],
      denied_title_patterns: [],
    })).toEqual({});
  });

  it("keeps actual connector scope changes in the approval request", () => {
    expect(changedApprovalGatedSourceUpdate(confluenceSource, {
      get_child_pages: true,
      allowed_title_patterns: [],
      denied_title_patterns: [],
    })).toEqual({ get_child_pages: true });
  });

  const webSource: IngestionSourceConfig = {
    source_id: "src_https___docs_example_test__primary",
    source_type: "web_url",
    name: "Example documentation",
    description: "",
    status: "active",
    default_chunk_size: 10000,
    default_chunk_overlap: 2000,
    reload_interval: 86400,
    config_driven: false,
    config_import_adopted: false,
    visibility: "team",
    shared_with_teams: [],
    url: "https://docs.example.test/",
    settings: {
      crawl_mode: "sitemap",
      max_depth: 2,
      max_pages: 2000,
      follow_external_links: false,
      allowed_url_patterns: [],
      denied_url_patterns: [],
      allow_non_public_urls: false,
    },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  it("does not require publication review to allow an existing internal URL", () => {
    const settings = {
      ...webSource.settings,
      allow_non_public_urls: true,
    };

    expect(changedApprovalGatedSourceUpdate(webSource, { settings })).toEqual({});
  });

  it("does not review web crawler runtime changes", () => {
    const settings = {
      ...webSource.settings,
      render_javascript: true,
      wait_for_selector: "#content",
      page_load_timeout: 30,
      download_delay: 0.25,
      concurrent_requests: 10,
      respect_robots_txt: true,
      user_agent: "Example crawler",
    };

    expect(changedApprovalGatedSourceUpdate(webSource, { settings })).toEqual({});
  });

  it("still reviews web crawl-scope changes", () => {
    const settings = {
      ...webSource.settings,
      max_pages: 4000,
      allow_non_public_urls: true,
    };

    expect(changedApprovalGatedSourceUpdate(webSource, { settings })).toEqual({
      settings,
    });
  });

  it("still reviews web URL-filter changes", () => {
    const settings = {
      ...webSource.settings,
      allowed_url_patterns: ["^https://docs\\.example\\.test/guides/"],
    };

    expect(changedApprovalGatedSourceUpdate(webSource, { settings })).toEqual({
      settings,
    });
  });
});
