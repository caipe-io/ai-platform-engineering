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

  it("merges a partial rules update, leaving other rules untouched", async () => {
    const platformConfig = {
      findOne: jest.fn().mockResolvedValue({
        _id: "platform_settings",
        publication_approval: {
          rules: {
            rag_collection_sharing: { required: true, team_slugs: [] },
            rag_collection_datasource_changes: { required: false, team_slugs: ["finance-team"] },
          },
        },
      }),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const teams = {
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([{ slug: "everyone" }, { slug: "finance-team" }]),
      }),
    };
    mockGetCollection.mockImplementation(async (name: string) =>
      name === "platform_config" ? platformConfig : teams,
    );

    const saved = await savePublicationApprovalSettings(
      {
        rules: {
          rag_collection_sharing: { required: false, team_slugs: [] },
        },
      },
      { subject: "admin-subject", email: "admin@example.com" },
    );

    expect(saved.rules.rag_collection_sharing).toEqual({
      required: false,
      team_slugs: [],
    });
    expect(saved.rules.rag_collection_datasource_changes).toEqual({
      required: false,
      team_slugs: ["finance-team"],
    });
  });

  it("preserves a rule's untouched fields when a PATCH only updates one field within that rule", async () => {
    const platformConfig = {
      findOne: jest.fn().mockResolvedValue({
        _id: "platform_settings",
        publication_approval: {
          rules: {
            rag_datasource_sharing: { required: false, team_slugs: ["finance-team"] },
          },
        },
      }),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const teams = {
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([{ slug: "everyone" }, { slug: "finance-team" }]),
      }),
    };
    mockGetCollection.mockImplementation(async (name: string) =>
      name === "platform_config" ? platformConfig : teams,
    );

    // Only flipping `required` back on must not reset the previously
    // configured `team_slugs` scope back to the "any team" default.
    const saved = await savePublicationApprovalSettings(
      {
        rules: {
          rag_datasource_sharing: { required: true },
        },
      },
      { subject: "admin-subject", email: "admin@example.com" },
    );

    expect(saved.rules.rag_datasource_sharing).toEqual({
      required: true,
      team_slugs: ["finance-team"],
    });
  });

  it("drops an unrecognized rule key from a PATCH without corrupting known rules", async () => {
    const platformConfig = {
      findOne: jest.fn().mockResolvedValue({
        _id: "platform_settings",
        publication_approval: {
          rules: {
            rag_datasource_sharing: { required: false, team_slugs: ["finance-team"] },
          },
        },
      }),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const teams = {
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([{ slug: "everyone" }, { slug: "finance-team" }]),
      }),
    };
    mockGetCollection.mockImplementation(async (name: string) =>
      name === "platform_config" ? platformConfig : teams,
    );

    const saved = await savePublicationApprovalSettings(
      {
        rules: {
          rag_datasource_sharing_typo: { required: true, team_slugs: ["everyone"] },
        },
      },
      { subject: "admin-subject", email: "admin@example.com" },
    );

    expect(saved.rules).not.toHaveProperty("rag_datasource_sharing_typo");
    expect(saved.rules.rag_datasource_sharing).toEqual({
      required: false,
      team_slugs: ["finance-team"],
    });
  });

  it("rejects a rule scoped to a team that does not exist", async () => {
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
        {
          rules: {
            rag_collection_sharing: { required: true, team_slugs: ["missing-team"] },
          },
        },
        { subject: "admin-subject", email: "admin@example.com" },
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "PUBLICATION_POLICY_TEAM_NOT_FOUND",
    });
    expect(platformConfig.updateOne).not.toHaveBeenCalled();
  });

  it("normalizes and persists Slack/Webex onboarding team scopes", async () => {
    const platformConfig = {
      findOne: jest.fn().mockResolvedValue(null),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const teams = {
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([{ slug: "everyone" }, { slug: "sales-team" }]),
      }),
    };
    mockGetCollection.mockImplementation(async (name: string) =>
      name === "platform_config" ? platformConfig : teams,
    );

    const saved = await savePublicationApprovalSettings(
      {
        slack_onboarding_team_slugs: ["Sales-Team", "sales-team"],
        webex_onboarding_team_slugs: ["Sales-Team"],
      },
      { subject: "admin-subject", email: "admin@example.com" },
    );

    expect(saved.slack_onboarding_team_slugs).toEqual(["sales-team"]);
    expect(saved.webex_onboarding_team_slugs).toEqual(["sales-team"]);
  });

  it("rejects a Slack or Webex onboarding scope referencing a team that does not exist", async () => {
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
        { webex_onboarding_team_slugs: ["missing-team"] },
        { subject: "admin-subject", email: "admin@example.com" },
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "PUBLICATION_POLICY_TEAM_NOT_FOUND",
    });
    expect(platformConfig.updateOne).not.toHaveBeenCalled();
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
