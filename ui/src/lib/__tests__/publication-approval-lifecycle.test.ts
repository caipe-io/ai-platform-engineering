import {
  acquirePublicationRequestForApproval,
  cancelPublicationRequest,
  canApprovePublicationRequest,
  createPublicationRequest,
  failPublicationApproval,
  invalidatePublicationRequests,
  listPublicationRequestsPageForActor,
  replacePendingConnectorPublicationRequest,
} from "@/lib/publication-approval.server";
import {
  DEFAULT_PUBLICATION_APPROVAL_SETTINGS,
} from "@/lib/publication-approval-settings";
import type {
  PublicationActor,
  PublicationRequestDocument,
} from "@/types/publication-approval";

const mockGetCollection = jest.fn();
const mockCheckOpenFgaTuple = jest.fn();
const mockListOpenFgaObjects = jest.fn();
const mockReconcileTupleDiff = jest.fn();
const mockGetPublicationApprovalSettings = jest.fn();
const mockCreateInAppNotification = jest.fn().mockResolvedValue(undefined);

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/authz", () => ({
  reconcileTupleDiff: (...args: unknown[]) => mockReconcileTupleDiff(...args),
}));

jest.mock("@/lib/in-app-notifications.server", () => ({
  archiveInAppNotifications: jest.fn().mockResolvedValue(undefined),
  createInAppNotification: (...args: unknown[]) => mockCreateInAppNotification(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
  listOpenFgaObjects: (...args: unknown[]) => mockListOpenFgaObjects(...args),
}));

jest.mock("@/lib/publication-approval-settings", () => {
  const actual = jest.requireActual("@/lib/publication-approval-settings");
  return {
    ...actual,
    getPublicationApprovalSettings: (...args: unknown[]) =>
      mockGetPublicationApprovalSettings(...args),
  };
});

const REQUESTER: PublicationActor = {
  subject: "requester-subject",
  email: "requester@example.com",
  name: "Requesting User",
};

const APPROVER: PublicationActor = {
  subject: "approver-subject",
  email: "approver@example.com",
  name: "Approving User",
};

function request(
  overrides: Partial<PublicationRequestDocument> = {},
): PublicationRequestDocument {
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
    resource_revision: "revision-primary",
    requested_state: { search_team_slugs: ["target-team"] },
    effective_state: { search_team_slugs: [] },
    risk_facts: {
      organization_wide: false,
      target_team_slugs: ["target-team"],
      reasons: ["new team audience"],
    },
    requester: REQUESTER,
    requester_team_slugs: ["requester-team"],
    approver_team_slugs: ["approver-team"],
    status: "pending",
    history: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function emptyApplyingCursor() {
  return {
    limit: jest.fn().mockReturnThis(),
    toArray: jest.fn().mockResolvedValue([]),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPublicationApprovalSettings.mockResolvedValue({
    ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS,
    rag_reviewer_team_slugs: ["approver-team"],
  });
  mockCheckOpenFgaTuple.mockImplementation(
    async ({ relation }: { relation: string }) => ({
      allowed: relation === "can_approve",
    }),
  );
  mockListOpenFgaObjects.mockResolvedValue({
    objects: ["team:approver-team"],
  });
  mockReconcileTupleDiff.mockResolvedValue(undefined);
});

describe("publication approval delegation", () => {
  it("requires both approval access and a current RAG reviewer assignment", async () => {
    await expect(canApprovePublicationRequest(APPROVER, request())).resolves.toBe(
      true,
    );

    mockListOpenFgaObjects.mockResolvedValueOnce({
      objects: ["team:different-team"],
    });
    await expect(canApprovePublicationRequest(APPROVER, request())).resolves.toBe(
      false,
    );

    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    await expect(canApprovePublicationRequest(APPROVER, request())).resolves.toBe(
      false,
    );
  });

  it("allows a directly assigned person without a team assignment", async () => {
    mockGetPublicationApprovalSettings.mockResolvedValue({
      ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS,
      rag_reviewer_user_subjects: [APPROVER.subject],
    });
    const publicationRequest = request({
      approver_team_slugs: [],
      approver_user_subjects: [APPROVER.subject],
    });

    await expect(
      canApprovePublicationRequest(APPROVER, publicationRequest),
    ).resolves.toBe(true);
    await expect(
      canApprovePublicationRequest(
        { ...APPROVER, subject: "different-user" },
        publicationRequest,
      ),
    ).resolves.toBe(false);
  });

  it("does not let a Slack-only reviewer approve a RAG request", async () => {
    mockGetPublicationApprovalSettings.mockResolvedValue({
      ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS,
      slack_reviewer_team_slugs: ["approver-team"],
    });

    await expect(
      canApprovePublicationRequest(APPROVER, request()),
    ).resolves.toBe(false);
  });

  it("prevents organization-wide self-approval before acquiring the request", async () => {
    const publicationRequest = request({
      requester: APPROVER,
      risk_facts: {
        organization_wide: true,
        target_team_slugs: ["everyone"],
        reasons: ["new organization-wide audience"],
      },
    });
    const collection = {
      find: jest.fn().mockReturnValue(emptyApplyingCursor()),
      findOne: jest.fn().mockResolvedValue(publicationRequest),
      findOneAndUpdate: jest.fn(),
    };
    mockGetCollection.mockResolvedValue(collection);

    await expect(
      acquirePublicationRequestForApproval(publicationRequest._id, APPROVER),
    ).rejects.toMatchObject({ code: "SELF_APPROVAL_FORBIDDEN" });
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mockReconcileTupleDiff).not.toHaveBeenCalled();
  });

  it("allows an organization administrator to approve their own request", async () => {
    const publicationRequest = request({
      requester: APPROVER,
      risk_facts: {
        organization_wide: true,
        target_team_slugs: ["everyone"],
        reasons: ["new organization-wide audience"],
      },
    });
    const applying = {
      ...publicationRequest,
      status: "applying" as const,
      apply_started_at: "2026-01-01T00:01:00.000Z",
    };
    const collection = {
      find: jest.fn().mockReturnValue(emptyApplyingCursor()),
      findOne: jest.fn().mockResolvedValue(publicationRequest),
      findOneAndUpdate: jest.fn().mockResolvedValue(applying),
    };
    mockGetCollection.mockResolvedValue(collection);
    mockCheckOpenFgaTuple.mockImplementation(
      async ({ relation }: { relation: string }) => ({
        allowed: relation === "can_manage",
      }),
    );

    await expect(
      acquirePublicationRequestForApproval(publicationRequest._id, APPROVER),
    ).resolves.toEqual(applying);
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: publicationRequest._id, status: "pending" },
      expect.any(Object),
      { returnDocument: "after" },
    );
  });

  it("acquires one pending request and grants only its request-scoped apply capability", async () => {
    const publicationRequest = request();
    const applying = {
      ...publicationRequest,
      status: "applying" as const,
      apply_started_at: "2026-01-01T00:01:00.000Z",
    };
    const collection = {
      find: jest.fn().mockReturnValue(emptyApplyingCursor()),
      findOne: jest.fn().mockResolvedValue(publicationRequest),
      findOneAndUpdate: jest.fn().mockResolvedValue(applying),
    };
    mockGetCollection.mockResolvedValue(collection);

    await expect(
      acquirePublicationRequestForApproval(publicationRequest._id, APPROVER),
    ).resolves.toEqual(applying);
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: publicationRequest._id, status: "pending" },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "applying" }),
      }),
      { returnDocument: "after" },
    );
    expect(mockReconcileTupleDiff).toHaveBeenCalledWith(
      {
        writes: [
          {
            user: `user:${APPROVER.subject}`,
            relation: "approver",
            object: `policy:${publicationRequest.authorization_policy_id}`,
          },
        ],
        deletes: [],
      },
      expect.objectContaining({
        caller: { type: "user", id: APPROVER.subject },
      }),
    );
  });
});

describe("publication request lifecycle", () => {
  it("paginates a requester's history without exposing other users' requests", async () => {
    const history = request({ status: "rejected" });
    const historyCursor = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([history]),
    };
    const collection = {
      countDocuments: jest.fn().mockResolvedValue(21),
      find: jest.fn()
        .mockReturnValueOnce(emptyApplyingCursor())
        .mockReturnValueOnce(historyCursor),
    };
    mockGetCollection.mockResolvedValue(collection);

    await expect(listPublicationRequestsPageForActor(REQUESTER, {
      statuses: ["rejected"],
      mine: true,
      page: 2,
      pageSize: 20,
    })).resolves.toEqual({
      requests: [history],
      pagination: { page: 2, page_size: 20, total: 21, total_pages: 2 },
    });
    expect(collection.countDocuments).toHaveBeenCalledWith({
      status: { $in: ["rejected"] },
      "requester.subject": REQUESTER.subject,
    });
    expect(historyCursor.skip).toHaveBeenCalledWith(20);
    expect(historyCursor.limit).toHaveBeenCalledWith(20);
  });

  it("lets the requester withdraw a pending request", async () => {
    const pending = request();
    const cancelled = {
      ...pending,
      status: "cancelled" as const,
      decided_by: REQUESTER,
    };
    const collection = {
      findOne: jest.fn().mockResolvedValue(pending),
      findOneAndUpdate: jest.fn().mockResolvedValue(cancelled),
    };
    mockGetCollection.mockResolvedValue(collection);

    await expect(
      cancelPublicationRequest(pending._id, REQUESTER),
    ).resolves.toEqual(cancelled);
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: pending._id, status: "pending" },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "cancelled" }),
        $push: {
          history: expect.objectContaining({
            action: "cancelled",
            from_status: "pending",
            to_status: "cancelled",
          }),
        },
      }),
      { returnDocument: "after" },
    );
  });

  it("does not let another user withdraw the request", async () => {
    const pending = request();
    const collection = {
      findOne: jest.fn().mockResolvedValue(pending),
      findOneAndUpdate: jest.fn(),
    };
    mockGetCollection.mockResolvedValue(collection);

    await expect(
      cancelPublicationRequest(pending._id, APPROVER),
    ).rejects.toMatchObject({ code: "WITHDRAW_FORBIDDEN" });
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("persists requested and effective state separately and supersedes older proposals", async () => {
    let inserted: PublicationRequestDocument | null = null;
    const collection = {
      insertOne: jest.fn().mockImplementation(async (document) => {
        inserted = document as PublicationRequestDocument;
        return { acknowledged: true };
      }),
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockImplementation(async () =>
          inserted ? [inserted] : []),
      }),
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    mockGetCollection.mockResolvedValue(collection);

    const created = await createPublicationRequest({
      resource: {
        kind: "rag_datasource",
        id: "source-primary",
        label: "Primary source",
      },
      resourceRevision: "revision-primary",
      requestedState: { search_team_slugs: ["new-team"] },
      effectiveState: { search_team_slugs: ["existing-team"] },
      riskFacts: {
        organization_wide: false,
        target_team_slugs: ["new-team"],
        reasons: ["new team audience"],
      },
      requester: REQUESTER,
      requesterTeamSlugs: ["requester-team"],
      approverTeamSlugs: ["approver-team"],
      approverUserSubjects: ["approver-subject"],
    });

    expect(created.status).toBe("pending");
    expect(created.requested_state).toEqual({
      search_team_slugs: ["new-team"],
    });
    expect(created.effective_state).toEqual({
      search_team_slugs: ["existing-team"],
    });
    expect(created.approver_user_subjects).toEqual(["approver-subject"]);
    expect(collection.insertOne).toHaveBeenCalledWith(created);
    expect(collection.updateMany).toHaveBeenCalledWith(
      {
        "resource.kind": "rag_datasource",
        "resource.id": "source-primary",
        status: "pending",
        _id: { $ne: created._id },
      },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "superseded" }),
      }),
    );
    expect(mockCreateInAppNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        href: `/admin/security/approvals?request=${encodeURIComponent(created._id)}`,
      }),
    );
  });

  it("coalesces concurrent proposals without superseding the deterministic winner", async () => {
    const existing = request({
      _id: "request-existing",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const collection = {
      insertOne: jest.fn().mockResolvedValue({ acknowledged: true }),
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([existing]),
      }),
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    mockGetCollection.mockResolvedValue(collection);

    const created = await createPublicationRequest({
      resource: existing.resource,
      resourceRevision: "revision-primary",
      requestedState: { search_team_slugs: ["other-team"] },
      effectiveState: { search_team_slugs: [] },
      riskFacts: existing.risk_facts,
      requester: REQUESTER,
      requesterTeamSlugs: ["requester-team"],
      approverTeamSlugs: ["approver-team"],
    });

    expect(created.status).toBe("superseded");
    expect(collection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        _id: { $ne: "request-existing" },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: "superseded" }),
      }),
    );
  });

  it("fails deletion closed while an approval adapter is applying", async () => {
    const collection = {
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      findOne: jest.fn().mockResolvedValue(request({ status: "applying" })),
      find: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
    };
    mockGetCollection.mockResolvedValue(collection);

    await expect(
      invalidatePublicationRequests(
        {
          kind: "rag_datasource",
          id: "source-primary",
          label: "Primary source",
        },
        REQUESTER,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PUBLICATION_APPLY_IN_PROGRESS",
    });
  });

  it("does not let one requester replace another user's connector request", async () => {
    const otherRequester = request({
      resource: {
        kind: "slack_channel",
        id: "workspace-primary/channel-primary",
        label: "Slack: #primary",
      },
      requester: {
        subject: "other-subject",
        email: "other@example.com",
        name: "Other User",
      },
    });
    const collection = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([otherRequester]),
      }),
    };
    mockGetCollection.mockResolvedValue(collection);

    await expect(replacePendingConnectorPublicationRequest(
      otherRequester.resource,
      REQUESTER,
      "A newer request replaced this one.",
    )).rejects.toMatchObject({
      statusCode: 409,
      code: "PUBLICATION_REQUEST_OWNED_BY_ANOTHER_USER",
    });
  });

  it("keeps a failed apply locked until its temporary capability is revoked", async () => {
    const applying = request({
      status: "applying",
      apply_started_at: "2026-01-01T00:01:00.000Z",
    });
    const collection = {
      findOne: jest.fn().mockResolvedValue(applying),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    mockGetCollection.mockResolvedValue(collection);
    mockReconcileTupleDiff.mockRejectedValueOnce(
      new Error("authorization service unavailable"),
    );
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      failPublicationApproval(
        applying._id,
        APPROVER,
        new Error("adapter failed"),
      ),
    ).resolves.toBeUndefined();

    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: applying._id, status: "applying" },
      expect.objectContaining({
        $set: expect.objectContaining({
          last_error: expect.stringContaining("apply-capability cleanup failed"),
        }),
      }),
    );
    expect(collection.updateOne.mock.calls[0][1].$set).not.toHaveProperty(
      "status",
    );
    expect(collection.updateOne.mock.calls[0][1]).not.toHaveProperty("$unset");
    consoleError.mockRestore();
  });
});
