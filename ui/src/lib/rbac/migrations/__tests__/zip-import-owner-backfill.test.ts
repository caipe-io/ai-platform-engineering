/** @jest-environment node */

const mockGetCollection = jest.fn();
const mockReadOpenFgaTuples = jest.fn();
const mockWriteOpenFgaTupleDiff = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  readOpenFgaTuples: (...args: unknown[]) => mockReadOpenFgaTuples(...args),
  writeOpenFgaTupleDiff: (...args: unknown[]) =>
    mockWriteOpenFgaTupleDiff(...args),
}));

import {
applyZipImportOwnerBackfillMigration,
deriveZipImportOwnerBackfillPlan,
ZIP_IMPORT_OWNER_BACKFILL_CONFIRMATION,
ZIP_IMPORT_OWNER_BACKFILL_MIGRATION_ID,
} from "../zip-import-owner-backfill";
import { planMigration } from "../registry";

describe("zip_import_owner_backfill_v1", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadOpenFgaTuples.mockResolvedValue({
      tuples: [],
      continuationToken: undefined,
    });
    mockGetCollection.mockImplementation(async (name: string) => ({
      find: () => ({
        toArray: async () =>
          name === "agent_skills"
            ? [
                {
                  id: "skill-imported-1",
                  owner_id: "alice@example.com",
                  category: "imported",
                  is_system: false,
                },
              ]
            : [
                {
                  email: "alice@example.com",
                  keycloak_sub: "alice-sub",
                },
              ],
      }),
    }));
  });

  it("adds only missing owner and creator tuples for imported skills", () => {
    const plan = deriveZipImportOwnerBackfillPlan({
      skills: [
        {
          id: "skill-imported-1",
          owner_id: "alice@example.com",
          category: "imported",
          is_system: false,
        },
        {
          id: "skill-manual-1",
          owner_id: "alice@example.com",
          category: "Custom",
          is_system: false,
        },
      ],
      subjectsByOwnerEmail: new Map([["alice@example.com", "alice-sub"]]),
      existingTuples: [
        {
          user: "user:alice-sub",
          relation: "creator",
          object: "skill:skill-imported-1",
        },
        {
          user: "team:platform#member",
          relation: "user",
          object: "skill:skill-imported-1",
        },
      ],
    });

    expect(plan.tuples).toEqual([
      {
        user: "user:alice-sub",
        relation: "owner",
        object: "skill:skill-imported-1",
      },
    ]);
    expect(plan.counts.skills_repaired).toBe(1);
    expect(plan.confirmation).toBe(ZIP_IMPORT_OWNER_BACKFILL_CONFIRMATION);
  });

  it("warns instead of inventing a subject when owner identity is unresolved", () => {
    const plan = deriveZipImportOwnerBackfillPlan({
      skills: [
        {
          id: "skill-imported-1",
          owner_id: "missing@example.com",
          category: "imported",
        },
      ],
      subjectsByOwnerEmail: new Map(),
      existingTuples: [],
    });

    expect(plan.tuples).toEqual([]);
    expect(plan.counts.owner_subjects_missing).toBe(1);
    expect(plan.warnings[0]).toContain("missing@example.com");
  });

  it("is idempotent when both tuples already exist", () => {
    const tuples = ["creator", "owner"].map((relation) => ({
      user: "user:alice-sub",
      relation,
      object: "skill:skill-imported-1",
    }));
    const plan = deriveZipImportOwnerBackfillPlan({
      skills: [
        {
          id: "skill-imported-1",
          owner_id: "alice@example.com",
          category: "imported",
        },
      ],
      subjectsByOwnerEmail: new Map([["alice@example.com", "alice-sub"]]),
      existingTuples: tuples,
    });

    expect(plan.tuples).toEqual([]);
    expect(plan.counts.skills_repaired).toBe(0);
  });

  it("is wired through the migration registry", async () => {
    const plan = await planMigration(ZIP_IMPORT_OWNER_BACKFILL_MIGRATION_ID);
    expect(plan.migration_id).toBe(ZIP_IMPORT_OWNER_BACKFILL_MIGRATION_ID);
    expect(plan.from_version).toBe(2);
    expect(plan.to_version).toBe(3);
  });

  it("applies the planned writes without deleting unrelated grants", async () => {
    mockWriteOpenFgaTupleDiff.mockResolvedValue({
      enabled: true,
      writes: 2,
      deletes: 0,
    });
    const plan = deriveZipImportOwnerBackfillPlan({
      skills: [
        {
          id: "skill-imported-1",
          owner_id: "alice@example.com",
          category: "imported",
        },
      ],
      subjectsByOwnerEmail: new Map([["alice@example.com", "alice-sub"]]),
      existingTuples: [],
    });

    await applyZipImportOwnerBackfillMigration({
      plan,
      actor: "admin@example.com",
      now: "2026-08-10T00:00:00.000Z",
    });

    expect(mockWriteOpenFgaTupleDiff).toHaveBeenCalledWith({
      writes: plan.tuples,
      deletes: [],
    });
  });
});
