import {
  applyRagPublicationRequest,
  changedApprovalGatedSourceUpdate,
  ragPublicationRevision,
  ragPublicationRevisionBasis,
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

  // Regression: a request whose datasource has no Mongo row yet (e.g. a
  // local-file upload still ingesting) must not be treated as a full-content
  // mismatch just because the live "ownership" snapshot can't report content
  // fields. Only ownership and the search audience are comparable here.
  function requestWithBasis(overrides: {
    requestedSearchTeamSlugs: string[];
    snapshotSearchTeamSlugs: string[];
  }): PublicationRequestDocument {
    const base = request("owner-subject");
    return {
      ...base,
      requested_state: {
        search_team_slugs: overrides.requestedSearchTeamSlugs,
        search_user_subjects: [],
      },
      revision_basis: {
        source: {
          source_id: "source-primary",
          owner_team_slug: null,
          owner_subject: "owner-subject",
        },
        search_team_slugs: overrides.snapshotSearchTeamSlugs,
        search_user_subjects: [],
      },
    };
  }

  it("requires confirmation (not a hard conflict) when Search grew before a source row exists", async () => {
    mockReadOpenFgaTuples.mockResolvedValue({
      tuples: [
        { key: { object: "knowledge_base:source-primary", relation: "reader", user: "team:reader-team#member" } },
        { key: { object: "knowledge_base:source-primary", relation: "reader", user: "team:extra-team#member" } },
      ],
    });
    jest.spyOn(global, "fetch").mockResolvedValueOnce(
      response(200, {
        datasource_id: "source-primary",
        owner_team_slug: null,
        owner_subject: "owner-subject",
        creator_subject: "creator-subject",
      }),
    );
    const publicationRequest = requestWithBasis({
      requestedSearchTeamSlugs: ["reader-team"],
      snapshotSearchTeamSlugs: ["reader-team"],
    });

    const error = await applyRagPublicationRequest(publicationRequest, "access-token").catch(
      (caught) => caught,
    );
    expect(error).toMatchObject({ code: "PUBLICATION_DRIFT" });
    expect(error.drift).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "search_team_slugs", after: ["extra-team", "reader-team"] }),
      ]),
    );
  });

  it("applies cleanly with no source row when nothing has actually changed", async () => {
    mockReadOpenFgaTuples.mockResolvedValue({
      tuples: [
        { key: { object: "knowledge_base:source-primary", relation: "reader", user: "team:reader-team#member" } },
      ],
    });
    jest
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
    const publicationRequest = requestWithBasis({
      requestedSearchTeamSlugs: ["reader-team"],
      snapshotSearchTeamSlugs: ["reader-team"],
    });

    await expect(
      applyRagPublicationRequest(publicationRequest, "access-token"),
    ).resolves.toEqual([]);
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

describe("drift confirmation for a locally-tracked datasource", () => {
  const baseSource: IngestionSourceConfig = {
    source_id: "source-local",
    source_type: "confluence_space",
    name: "Local KB",
    description: "Original description",
    status: "active",
    default_chunk_size: 1000,
    default_chunk_overlap: 200,
    reload_interval: 86400,
    config_driven: false,
    config_import_adopted: false,
    visibility: "team",
    shared_with_teams: [],
    owner_team_slug: "owner-team",
    search_with_teams: ["reader-team"],
    search_with_users: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  } as unknown as IngestionSourceConfig;

  const effectiveState = {
    search_team_slugs: ["reader-team"],
    search_user_subjects: [],
  };

  function localRequest(
    snapshotSource: IngestionSourceConfig,
  ): PublicationRequestDocument {
    const basis = ragPublicationRevisionBasis(snapshotSource, effectiveState);
    return {
      _id: "request-local",
      adapter_version: 1,
      resource: {
        kind: "rag_datasource",
        id: snapshotSource.source_id,
        label: snapshotSource.name,
      },
      authorization_policy_id:
        "publication.rag_datasource.0123456789abcdef01234567.request-local",
      resource_revision: publicationResourceRevision(basis),
      revision_basis: basis,
      requested_state: {
        search_team_slugs: effectiveState.search_team_slugs,
        search_user_subjects: effectiveState.search_user_subjects,
      },
      effective_state: effectiveState,
      risk_facts: {
        organization_wide: false,
        target_team_slugs: ["reader-team"],
        reasons: [],
      },
      requester: { subject: "requester-subject" },
      requester_team_slugs: ["owner-team"],
      approver_team_slugs: ["approver-team"],
      status: "applying",
      history: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
  }

  function mockSourceCollection(
    liveSource: IngestionSourceConfig,
  ): { findOne: jest.Mock; findOneAndUpdate: jest.Mock } {
    const collectionMock = {
      findOne: jest.fn().mockResolvedValue(liveSource),
      findOneAndUpdate: jest.fn().mockResolvedValue(liveSource),
    };
    mockGetCollection.mockResolvedValueOnce(collectionMock);
    return collectionMock;
  }

  it("requires confirmation when the live datasource name changed", async () => {
    const snapshotSource = baseSource;
    const liveSource = { ...baseSource, name: "Renamed KB" };
    mockSourceCollection(liveSource);

    const error = await applyRagPublicationRequest(
      localRequest(snapshotSource),
      "access-token",
    ).catch((caught) => caught);

    expect(error).toMatchObject({ code: "PUBLICATION_DRIFT" });
    expect(error.drift).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "name", before: "Local KB", after: "Renamed KB" }),
      ]),
    );
  });

  it("requires confirmation and warns before overwriting grown Search teams", async () => {
    const snapshotSource = baseSource;
    const liveSource = {
      ...baseSource,
      search_with_teams: ["reader-team", "extra-team"],
    };
    mockSourceCollection(liveSource);

    const error = await applyRagPublicationRequest(
      localRequest(snapshotSource),
      "access-token",
    ).catch((caught) => caught);

    expect(error).toMatchObject({ code: "PUBLICATION_DRIFT" });
    expect(error.drift).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "search_team_slugs",
          after: ["extra-team", "reader-team"],
          will_apply: ["reader-team"],
        }),
      ]),
    );
  });

  it("does not treat a reordered projection array as drift", async () => {
    const snapshotSource = { ...baseSource, page_configs: ["page-a", "page-b"] };
    const liveSource = { ...baseSource, page_configs: ["page-b", "page-a"] };
    mockSourceCollection(liveSource);

    await expect(
      applyRagPublicationRequest(localRequest(snapshotSource), "access-token"),
    ).resolves.toEqual([]);
  });

  it("treats a live Owner change as a hard conflict, not a confirmable drift", async () => {
    const snapshotSource = baseSource;
    const liveSource = { ...baseSource, owner_team_slug: "different-team" };
    mockSourceCollection(liveSource);

    await expect(
      applyRagPublicationRequest(localRequest(snapshotSource), "access-token"),
    ).rejects.toMatchObject({ code: "PUBLICATION_REVISION_CONFLICT" });
  });

  it("treats a pre-migration request with no revision snapshot as a hard conflict", async () => {
    const snapshotSource = baseSource;
    // Search teams (not just an informational field) must also differ so the
    // pre-existing "already applied" shortcut doesn't short-circuit first.
    const liveSource = {
      ...baseSource,
      name: "Renamed KB",
      search_with_teams: ["reader-team", "extra-team"],
    };
    mockSourceCollection(liveSource);
    const requestWithoutBasis = localRequest(snapshotSource);
    delete requestWithoutBasis.revision_basis;

    await expect(
      applyRagPublicationRequest(requestWithoutBasis, "access-token"),
    ).rejects.toMatchObject({ code: "PUBLICATION_REVISION_CONFLICT" });
  });

  it("applies once the approver acknowledges the exact drift fingerprint", async () => {
    const snapshotSource = baseSource;
    const liveSource = { ...baseSource, name: "Renamed KB" };
    mockSourceCollection(liveSource);

    const firstAttempt = await applyRagPublicationRequest(
      localRequest(snapshotSource),
      "access-token",
    ).catch((caught) => caught);
    expect(firstAttempt).toMatchObject({ code: "PUBLICATION_DRIFT" });

    mockSourceCollection(liveSource);
    jest.spyOn(global, "fetch").mockResolvedValue(response(200, { changed: true }));

    await expect(
      applyRagPublicationRequest(localRequest(snapshotSource), "access-token", {
        acknowledgedFingerprint: firstAttempt.fingerprint,
      }),
    ).resolves.toMatchObject([{ field: "name", before: "Local KB", after: "Renamed KB" }]);
  });

  it("re-drifts when the fingerprint was acknowledged but the datasource changed again", async () => {
    const snapshotSource = baseSource;
    mockSourceCollection({ ...baseSource, name: "Renamed KB" });

    const stale = await applyRagPublicationRequest(
      localRequest(snapshotSource),
      "access-token",
    ).catch((caught) => caught);
    expect(stale).toMatchObject({ code: "PUBLICATION_DRIFT" });

    mockSourceCollection({ ...baseSource, name: "Renamed Again KB" });
    const fetchSpy = jest.spyOn(global, "fetch");

    const error = await applyRagPublicationRequest(
      localRequest(snapshotSource),
      "access-token",
      { acknowledgedFingerprint: stale.fingerprint },
    ).catch((caught) => caught);

    expect(error).toMatchObject({ code: "PUBLICATION_DRIFT" });
    expect(error.fingerprint).not.toBe(stale.fingerprint);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the datasource revision hash stable across the basis refactor", () => {
    // Pinned, not derived from the function under test: `ragPublicationRevision`
    // is now literally defined as `publicationResourceRevision(ragPublicationRevisionBasis(...))`,
    // so asserting one against the other can never fail. A hardcoded hash is
    // the only thing that actually protects in-flight pending requests from a
    // future accidental change to the basis shape silently hard-conflicting.
    expect(ragPublicationRevision(baseSource, effectiveState)).toBe(
      "71e7229a09d9ce2afc74ede693e652a3bde552d0c71aabdd4d9f2cbd9f0480f2",
    );
  });
});
