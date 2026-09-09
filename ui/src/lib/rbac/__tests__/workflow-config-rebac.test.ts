/**
 * @jest-environment node
 */

import { ApiError } from "@/lib/api-error";

const mockRequireResourcePermission = jest.fn();
const mockReconcileShareableResource = jest.fn();
const mockListUserTeamSlugs = jest.fn();
const mockGetCollection = jest.fn();

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
  subjectFromSession: () => "alice-sub",
}));

jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileShareableResource: (...args: unknown[]) =>
    mockReconcileShareableResource(...args),
}));

jest.mock("@/lib/rbac/openfga-team-membership", () => ({
  listUserTeamSlugs: (...args: unknown[]) => mockListUserTeamSlugs(...args),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

import {
  effectiveWorkflowVisibility,
  filterWorkflowConfigsByRunAccess,
  reconcileWorkflowConfigAccess,
  requireWorkflowConfigRunAccess,
  workflowRunAllowedByVisibility,
  workflowWriteAllowedByVisibility,
} from "@/lib/rbac/workflow-config-rebac";

describe("workflow-config-rebac", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReconcileShareableResource.mockResolvedValue({
      enabled: true,
      writes: 2,
      deletes: 0,
    });
    mockListUserTeamSlugs.mockResolvedValue(["platform-eng"]);
  });

  it("reconciles workflow configs as task resources with creator owner", async () => {
    await reconcileWorkflowConfigAccess(
      { sub: "alice-sub" },
      { _id: "wf-1", visibility: "global", shared_with_teams: null },
    );

    expect(mockReconcileShareableResource).toHaveBeenCalledWith(
      expect.objectContaining({
        objectType: "task",
        objectId: "wf-1",
        creatorSubject: "alice-sub",
        ownerSubject: "alice-sub",
        sharedWithOrg: true,
      }),
    );
  });

  describe("effectiveWorkflowVisibility", () => {
    it("defaults system-owned and config-driven workflows to global when visibility is missing", () => {
      expect(
        effectiveWorkflowVisibility({
          visibility: undefined,
          owner_id: "system",
          config_driven: true,
        }),
      ).toBe("global");
    });

    it("treats missing visibility on user-owned workflows as private", () => {
      expect(
        effectiveWorkflowVisibility({
          visibility: null,
          owner_id: "alice@example.com",
        }),
      ).toBe("private");
    });
  });

  describe("workflowRunAllowedByVisibility", () => {
    it("allows any user for global workflows", () => {
      expect(
        workflowRunAllowedByVisibility(
          {
            visibility: "global",
            shared_with_teams: null,
            owner_id: "owner@example.com",
          },
          "bob@example.com",
          [],
        ),
      ).toBe(true);
    });

    it("allows any user for system-seeded workflows without a visibility field", () => {
      expect(
        workflowRunAllowedByVisibility(
          {
            visibility: undefined,
            shared_with_teams: null,
            owner_id: "system",
            config_driven: true,
          },
          "bob@example.com",
          [],
        ),
      ).toBe(true);
    });

    it("allows team members when workflow is shared with their team", () => {
      expect(
        workflowRunAllowedByVisibility(
          {
            visibility: "team",
            shared_with_teams: ["Platform-Eng"],
            owner_id: "owner@example.com",
          },
          "bob@example.com",
          ["platform-eng"],
        ),
      ).toBe(true);
    });

    it("denies team workflows when user is not on a shared team", () => {
      expect(
        workflowRunAllowedByVisibility(
          {
            visibility: "team",
            shared_with_teams: ["other-team"],
            owner_id: "owner@example.com",
          },
          "bob@example.com",
          ["platform-eng"],
        ),
      ).toBe(false);
    });

    it("allows team workflow owner even when not on the shared team", () => {
      expect(
        workflowRunAllowedByVisibility(
          {
            visibility: "team",
            shared_with_teams: ["eti-sre-admin-jenkins"],
            owner_id: "owner@example.com",
          },
          "owner@example.com",
          [],
        ),
      ).toBe(true);
    });

    it("resolves legacy Mongo team _id refs via teamRefToSlug map", () => {
      const teamRefToSlug = new Map<string, string>([
        ["507f1f77bcf86cd799439011", "platform-eng"],
        ["platform-eng", "platform-eng"],
      ]);
      expect(
        workflowRunAllowedByVisibility(
          {
            visibility: "team",
            shared_with_teams: ["507f1f77bcf86cd799439011"],
            owner_id: "owner@example.com",
          },
          "bob@example.com",
          ["platform-eng"],
          teamRefToSlug,
        ),
      ).toBe(true);
    });

    it("allows only the owner for private workflows", () => {
      expect(
        workflowRunAllowedByVisibility(
          {
            visibility: "private",
            shared_with_teams: null,
            owner_id: "alice@example.com",
          },
          "alice@example.com",
          [],
        ),
      ).toBe(true);
      expect(
        workflowRunAllowedByVisibility(
          {
            visibility: "private",
            shared_with_teams: null,
            owner_id: "alice@example.com",
          },
          "bob@example.com",
          [],
        ),
      ).toBe(false);
    });
  });

  it("fails closed when workflow authorization reconciliation is pending", async () => {
    await expect(
      requireWorkflowConfigRunAccess(
        { sub: "alice-sub" },
        {
          _id: "wf-pending",
          owner_id: "alice@example.com",
          visibility: "private",
          authz_sync_state: "pending",
        },
        "alice@example.com",
        [],
      ),
    ).rejects.toMatchObject({ statusCode: 503, code: "AUTHZ_SYNC_PENDING" });
  });

  it("skips OpenFGA when global visibility allows run", async () => {
    await expect(
      requireWorkflowConfigRunAccess(
        { sub: "alice-sub" },
        {
          _id: "wf-global",
          owner_id: "owner@example.com",
          visibility: "global",
          shared_with_teams: null,
        },
        "bob@example.com",
        [],
      ),
    ).resolves.toBeUndefined();

    expect(mockRequireResourcePermission).not.toHaveBeenCalled();
  });

  it("allows the documented owner when OpenFGA use is denied", async () => {
    mockRequireResourcePermission.mockRejectedValue(
      new ApiError("denied", 403),
    );

    await expect(
      requireWorkflowConfigRunAccess(
        { sub: "alice-sub" },
        {
          _id: "wf-legacy",
          owner_id: "alice@example.com",
          visibility: "private",
          shared_with_teams: null,
        },
        "alice@example.com",
        [],
      ),
    ).resolves.toBeUndefined();

    expect(mockRequireResourcePermission).not.toHaveBeenCalled();
  });

  it("allows write only for the workflow owner (not system-owned)", () => {
    expect(
      workflowWriteAllowedByVisibility(
        {
          visibility: "global",
          shared_with_teams: null,
          owner_id: "alice@example.com",
        },
        "alice@example.com",
      ),
    ).toBe(true);
    expect(
      workflowWriteAllowedByVisibility(
        { visibility: "global", shared_with_teams: null, owner_id: "system" },
        "alice@example.com",
      ),
    ).toBe(false);
    expect(
      workflowWriteAllowedByVisibility(
        {
          visibility: "global",
          shared_with_teams: null,
          owner_id: "other@example.com",
        },
        "alice@example.com",
      ),
    ).toBe(false);
  });

  it("filters configs by visibility for list endpoints", () => {
    const configs = [
      {
        _id: "wf-global",
        visibility: "global" as const,
        shared_with_teams: null,
        owner_id: "a@example.com",
      },
      {
        _id: "wf-team",
        visibility: "team" as const,
        shared_with_teams: ["platform-eng"],
        owner_id: "a@example.com",
      },
      {
        _id: "wf-private",
        visibility: "private" as const,
        shared_with_teams: null,
        owner_id: "a@example.com",
      },
    ];

    const visible = filterWorkflowConfigsByRunAccess(
      configs,
      "bob@example.com",
      ["platform-eng"],
    );
    expect(visible.map((c) => c._id)).toEqual(["wf-global", "wf-team"]);
  });
});
