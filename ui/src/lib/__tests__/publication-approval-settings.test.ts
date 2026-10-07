import { savePublicationApprovalSettings } from "@/lib/publication-approval-settings";

const mockGetCollection = jest.fn();
const mockReconcileTupleDiff = jest.fn();
const mockResolveUserIdentitiesBySubject = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/authz", () => ({
  reconcileTupleDiff: (...args: unknown[]) => mockReconcileTupleDiff(...args),
}));

jest.mock("@/lib/rbac/user-identity-directory", () => ({
  resolveUserIdentitiesBySubject: (...args: unknown[]) =>
    mockResolveUserIdentitiesBySubject(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockReconcileTupleDiff.mockResolvedValue(undefined);
  mockResolveUserIdentitiesBySubject.mockResolvedValue(new Map());
});

describe("publication approval settings persistence", () => {
  it("rejects dangling trusted or approver team references", async () => {
    const platformConfig = {
      findOne: jest.fn().mockResolvedValue(null),
      updateOne: jest.fn(),
    };
    const teams = {
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([]),
      }),
    };
    mockGetCollection.mockImplementation(async (name: string) =>
      name === "platform_config" ? platformConfig : teams,
    );

    await expect(
      savePublicationApprovalSettings(
        { rag_reviewer_team_slugs: ["missing-approvers"] },
        { subject: "admin-subject", email: "admin@example.com" },
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "PUBLICATION_POLICY_TEAM_NOT_FOUND",
    });
    expect(mockReconcileTupleDiff).not.toHaveBeenCalled();
    expect(platformConfig.updateOne).not.toHaveBeenCalled();
  });

  it("grants delegated team members live approval and removes the legacy admin-only tuple", async () => {
    const platformConfig = {
      findOne: jest.fn().mockResolvedValue({
        _id: "platform_settings",
        publication_approval: {
          rag_reviewer_team_slugs: ["old-approvers"],
        },
      }),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const teams = {
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([
          { slug: "new-approvers" },
          { slug: "everyone" },
        ]),
      }),
    };
    mockGetCollection.mockImplementation(async (name: string) =>
      name === "platform_config" ? platformConfig : teams,
    );

    await savePublicationApprovalSettings(
      { rag_reviewer_team_slugs: ["new-approvers"] },
      { subject: "admin-subject", email: "admin@example.com" },
    );

    expect(mockReconcileTupleDiff).toHaveBeenCalledWith(
      {
        writes: [
          {
            user: "team:new-approvers#member",
            relation: "approver",
            object: "policy:publication",
          },
        ],
        deletes: expect.arrayContaining([
          {
            user: "team:old-approvers#member",
            relation: "approver",
            object: "policy:publication",
          },
          {
            user: "team:old-approvers#admin",
            relation: "approver",
            object: "policy:publication",
          },
        ]),
      },
      expect.objectContaining({
        caller: { type: "user", id: "admin-subject" },
      }),
    );
    expect(platformConfig.updateOne).toHaveBeenCalled();
  });

  it("treats PATCH input as a partial update and preserves nested policy values", async () => {
    const platformConfig = {
      findOne: jest.fn().mockResolvedValue({
        _id: "platform_settings",
        publication_approval: {
          require_rag_publication_approval: true,
          trusted_publishers_bypass: false,
          thresholds: {
            slack_channel_members_without_approval: 25,
          },
        },
      }),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const teams = {
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([{ slug: "everyone" }]),
      }),
    };
    mockGetCollection.mockImplementation(async (name: string) =>
      name === "platform_config" ? platformConfig : teams,
    );

    const saved = await savePublicationApprovalSettings(
      { require_rag_publication_approval: false },
      { subject: "admin-subject", email: "admin@example.com" },
    );

    expect(saved.require_rag_publication_approval).toBe(false);
    expect(saved.trusted_publishers_bypass).toBe(false);
    expect(saved.thresholds.slack_channel_members_without_approval).toBe(25);
  });

  it("grants a selected person live approval access", async () => {
    const platformConfig = {
      findOne: jest.fn().mockResolvedValue(null),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const teams = {
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([{ slug: "everyone" }]),
      }),
    };
    mockGetCollection.mockImplementation(async (name: string) =>
      name === "platform_config" ? platformConfig : teams,
    );
    mockResolveUserIdentitiesBySubject.mockResolvedValue(new Map([
      ["reviewer-subject", { subject: "reviewer-subject" }],
    ]));

    await savePublicationApprovalSettings(
      { slack_reviewer_user_subjects: ["reviewer-subject"] },
      { subject: "admin-subject", email: "admin@example.com" },
    );

    expect(mockReconcileTupleDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        writes: expect.arrayContaining([{
          user: "user:reviewer-subject",
          relation: "approver",
          object: "policy:publication",
        }]),
      }),
      expect.anything(),
    );
  });
});
