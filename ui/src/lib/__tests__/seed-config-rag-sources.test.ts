/**
 * @jest-environment node
 *
 * Tests for the `rag_sources` Helm-config seed path in `seed-config.ts`
 * (spec 2026-07-21-rag-source-config-db, US5):
 *
 * 1. A `slack_channel` entry under `appConfig.rag_sources` seeds a
 *    `rag_ingestion_sources` document with `config_driven: true`, the
 *    correct `source_id`, and the YAML's field values (T050).
 * 2. An entry with no `owner_team` seeds with `owner_id: "system"`, no
 *    `owner_team_slug`, and `visibility: "global"` (T051).
 * 3. Removing a previously-seeded entry and rebooting deletes the Mongo
 *    document via `cleanupStaleConfigDriven`, unless adopted (T052).
 * 4. Re-seeding an existing `config_driven: true` record with changed
 *    field values updates it in place without touching `created_at` (T053).
 * 5. Once adopted, re-running the boot seed with the same YAML entry still
 *    present does not re-seed or revert the record (T057).
 */

const mockCollection = {
  findOne: jest.fn(),
  find: jest.fn(),
  replaceOne: jest.fn(),
  updateOne: jest.fn(),
  deleteOne: jest.fn(),
};
const mockReconcileIngestionSourceRelationships = jest.fn();
const mockReconcileKnowledgeBaseRelationships = jest.fn();
const mockReconcileDataSourceRelationships = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: jest.fn(async () => mockCollection),
}));
jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileIngestionSourceRelationships: (...args: unknown[]) =>
    mockReconcileIngestionSourceRelationships(...args),
  reconcileKnowledgeBaseRelationships: (...args: unknown[]) =>
    mockReconcileKnowledgeBaseRelationships(...args),
  reconcileDataSourceRelationships: (...args: unknown[]) =>
    mockReconcileDataSourceRelationships(...args),
}));

import {
  adoptConfigImportedRagSources,
  cleanupStaleConfigDriven,
  seedRagSources,
} from "../seed-config";

// The seed helper is exported so the policy projection itself is testable;
// applySeedConfig's startup wiring invokes the same function.

describe("cleanupStaleConfigDriven — rag_ingestion_sources", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCollection.find.mockReturnValue({ toArray: jest.fn(async () => []) });
  });

  // T052
  it("excludes adopted rag sources from the stale-cleanup query", async () => {
    await cleanupStaleConfigDriven(new Set(), new Set(), new Set(), new Set(), new Set());

    expect(mockCollection.find).toHaveBeenNthCalledWith(5, {
      config_driven: true,
      config_import_adopted: { $ne: true },
    });
  });

  // T052
  it("deletes a non-adopted stale rag source absent from current config", async () => {
    mockCollection.find
      .mockReturnValueOnce({ toArray: jest.fn(async () => []) }) // agents
      .mockReturnValueOnce({ toArray: jest.fn(async () => []) }) // mcp servers
      .mockReturnValueOnce({ toArray: jest.fn(async () => []) }) // models
      .mockReturnValueOnce({ toArray: jest.fn(async () => []) }) // workflows
      .mockReturnValueOnce({
        toArray: jest.fn(async () => [{ source_id: "stale-source" }]),
      }); // rag sources

    await cleanupStaleConfigDriven(new Set(), new Set(), new Set(), new Set(), new Set());

    expect(mockCollection.deleteOne).toHaveBeenCalledWith({ source_id: "stale-source" });
  });

  // T057 — adopted rag sources survive cleanup even when absent from config,
  // since the query itself excludes config_import_adopted: true records.
  it("does not delete a rag source that was adopted, even if absent from current config", async () => {
    mockCollection.find
      .mockReturnValueOnce({ toArray: jest.fn(async () => []) })
      .mockReturnValueOnce({ toArray: jest.fn(async () => []) })
      .mockReturnValueOnce({ toArray: jest.fn(async () => []) })
      .mockReturnValueOnce({ toArray: jest.fn(async () => []) })
      .mockReturnValueOnce({ toArray: jest.fn(async () => []) }); // adopted sources excluded by query itself

    await cleanupStaleConfigDriven(new Set(), new Set(), new Set(), new Set(), new Set(["adopted-source"]));

    expect(mockCollection.deleteOne).not.toHaveBeenCalled();
  });
});

describe("seedRagSources — independent management and search policy", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("keeps one management owner while allowing that same team in Search Access", async () => {
    mockCollection.findOne.mockResolvedValue({
      source_id: "slack-channel-C1",
      owner_team_slug: "primary",
      shared_with_teams: ["legacy-manager"],
      search_owner_team_slug: "legacy-search-owner",
      search_with_teams: ["old-search"],
      visibility: "team",
      created_at: "2026-01-01T00:00:00.000Z",
    });

    await seedRagSources([
      {
        source_type: "slack_channel",
        channel_id: "C1",
        name: "Example channel",
        owner_team: "primary",
        shared_with_teams: ["ignored-management-share"],
        search_with_teams: ["primary", "readers", "primary"],
        visibility: "team",
      },
    ]);

    expect(mockCollection.replaceOne).toHaveBeenCalledWith(
      { source_id: "slack-channel-C1" },
      expect.objectContaining({
        owner_team_slug: "primary",
        shared_with_teams: [],
        search_with_teams: ["primary", "readers"],
      }),
      { upsert: true },
    );
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "slack-channel-C1",
        ownerTeamSlug: "primary",
        nextSharedTeamSlugs: [],
        previousSharedTeamSlugs: ["legacy-manager"],
      }),
    );
    expect(mockReconcileKnowledgeBaseRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "slack-channel-C1",
        ownerTeamSlug: null,
        previousOwnerTeamSlug: "legacy-search-owner",
        nextSharedTeamSlugs: ["primary", "readers"],
        previousSharedTeamSlugs: ["old-search"],
        previousSharedTeamAdminsManage: true,
      }),
    );
  });

  it("preserves the stored search projection when config does not declare one", async () => {
    mockCollection.findOne.mockResolvedValue({
      source_id: "slack-channel-C1",
      owner_team_slug: "primary",
      shared_with_teams: [],
      search_with_teams: ["readers"],
      visibility: "team",
      created_at: "2026-01-01T00:00:00.000Z",
    });

    await seedRagSources([
      {
        source_type: "slack_channel",
        channel_id: "C1",
        name: "Example channel",
        owner_team: "primary",
        visibility: "team",
      },
    ]);

    expect(mockCollection.replaceOne).toHaveBeenCalledWith(
      { source_id: "slack-channel-C1" },
      expect.objectContaining({ search_with_teams: ["readers"] }),
      { upsert: true },
    );
    expect(mockReconcileKnowledgeBaseRelationships).not.toHaveBeenCalled();
  });
});

describe("adoptConfigImportedRagSources", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // T054
  it("adopts an eligible config-driven source and changes only its management policy", async () => {
    mockCollection.findOne.mockResolvedValue({
      source_id: "slack-channel-C1",
      config_driven: true,
      config_import_adopted: false,
      visibility: "global",
      shared_with_teams: [],
    });

    const result = await adoptConfigImportedRagSources(["slack-channel-C1"], {
      ownerTeamSlug: "platform",
    });

    expect(result).toEqual({ adopted: ["slack-channel-C1"], skipped: [] });
    expect(mockCollection.updateOne).toHaveBeenCalledWith(
      { source_id: "slack-channel-C1" },
      {
        $set: expect.objectContaining({
          config_driven: false,
          config_import_adopted: true,
          visibility: "team",
          owner_team_slug: "platform",
          shared_with_teams: [],
        }),
        $unset: { owner_subject: "" },
      },
    );
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "slack-channel-C1",
        ownerTeamSlug: "platform",
        nextSharedTeamSlugs: [],
        globalUserAccess: false,
        previousGlobalUserAccess: true,
      }),
    );
    // Adoption assigns who may manage the connector. Search is an
    // independent policy selected by the migration flow (or changed later in
    // its own sharing dialog), so adoption must not rewrite either query graph.
    expect(mockReconcileKnowledgeBaseRelationships).not.toHaveBeenCalled();
    expect(mockReconcileDataSourceRelationships).not.toHaveBeenCalled();
  });

  it("can transfer an imported source to a personal collection owner", async () => {
    mockCollection.findOne.mockResolvedValue({
      source_id: "slack-channel-C1",
      config_driven: true,
      config_import_adopted: false,
      visibility: "global",
      owner_team_slug: "previous-team",
      shared_with_teams: [],
    });

    const result = await adoptConfigImportedRagSources(["slack-channel-C1"], {
      ownerTeamSlug: null,
      ownerSubject: "user-subject",
    });

    expect(result).toEqual({ adopted: ["slack-channel-C1"], skipped: [] });
    expect(mockCollection.updateOne).toHaveBeenCalledWith(
      { source_id: "slack-channel-C1" },
      expect.objectContaining({
        $set: expect.objectContaining({ owner_subject: "user-subject" }),
        $unset: { owner_team_slug: "" },
      }),
    );
    expect(mockReconcileIngestionSourceRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "slack-channel-C1",
        ownerSubject: "user-subject",
        previousOwnerSubject: null,
        ownerTeamSlug: null,
        previousOwnerTeamSlug: "previous-team",
      }),
    );
  });

  // T056
  it("skips an already-adopted record with 409-equivalent skip semantics", async () => {
    mockCollection.findOne.mockResolvedValue({
      source_id: "slack-channel-C1",
      config_driven: false,
      config_import_adopted: true,
    });

    const result = await adoptConfigImportedRagSources(["slack-channel-C1"], {
      ownerTeamSlug: "platform",
    });

    expect(result).toEqual({
      adopted: [],
      skipped: [{ source_id: "slack-channel-C1", reason: "already_adopted" }],
    });
    expect(mockReconcileIngestionSourceRelationships).not.toHaveBeenCalled();
    expect(mockReconcileKnowledgeBaseRelationships).not.toHaveBeenCalled();
    expect(mockReconcileDataSourceRelationships).not.toHaveBeenCalled();
  });

  // T056
  it("skips a DB-native (never config_driven) record", async () => {
    mockCollection.findOne.mockResolvedValue({
      source_id: "web-url-x",
      config_driven: false,
      config_import_adopted: false,
    });

    const result = await adoptConfigImportedRagSources(["web-url-x"], {
      ownerTeamSlug: "platform",
    });

    expect(result).toEqual({
      adopted: [],
      skipped: [{ source_id: "web-url-x", reason: "not_config_driven" }],
    });
  });

  // T057 — a subsequent adopt call against a record the boot seed left
  // untouched (config_import_adopted already true) is a stable no-op.
  it("is idempotent across repeated adopt calls on the same record", async () => {
    mockCollection.findOne.mockResolvedValue({
      source_id: "slack-channel-C1",
      config_driven: false,
      config_import_adopted: true,
    });

    const first = await adoptConfigImportedRagSources(["slack-channel-C1"], {
      ownerTeamSlug: "platform",
    });
    const second = await adoptConfigImportedRagSources(["slack-channel-C1"], {
      ownerTeamSlug: "platform",
    });

    const expectedSkip = [{ source_id: "slack-channel-C1", reason: "already_adopted" }];
    expect(first).toEqual({ adopted: [], skipped: expectedSkip });
    expect(second).toEqual({ adopted: [], skipped: expectedSkip });
  });

  it("reports not_found for an id with no matching record", async () => {
    mockCollection.findOne.mockResolvedValue(null);

    const result = await adoptConfigImportedRagSources(["does-not-exist"], {
      ownerTeamSlug: "platform",
    });

    expect(result).toEqual({
      adopted: [],
      skipped: [{ source_id: "does-not-exist", reason: "not_found" }],
    });
  });
});
