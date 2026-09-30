import {
  planConnectorPublication,
  planRagCollectionPublication,
  planRagPublication,
} from "@/lib/publication-approval.server";
import {
  DEFAULT_PUBLICATION_APPROVAL_SETTINGS,
  normalizePublicationApprovalSettings,
} from "@/lib/publication-approval-settings";
import type { PublicationApprovalSettings } from "@/types/publication-approval";

jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn() }));
jest.mock("@/lib/authz", () => ({ reconcileTupleDiff: jest.fn() }));
jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: jest.fn(),
  listOpenFgaObjects: jest.fn(),
}));

const REQUESTER = {
  subject: "test-user-subject",
  email: "test-user@example.com",
  name: "Test User",
};

function settings(
  overrides: Partial<PublicationApprovalSettings> = {},
): PublicationApprovalSettings {
  return {
    ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS,
    ...overrides,
    thresholds: {
      ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS.thresholds,
      ...overrides.thresholds,
    },
  };
}

describe("publication approval policy", () => {
  it("keeps an existing RAG audience effective while a new team waits for approval", () => {
    const plan = planRagPublication({
      settings: settings(),
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: {
        search_team_slugs: ["existing-team"],
        search_user_subjects: [],
      },
      requestedState: {
        search_team_slugs: ["existing-team", "new-team"],
        search_user_subjects: [],
      },
      ownerTeamSlug: "owner-team",
    });

    expect(plan.requires_approval).toBe(true);
    expect(plan.effective_state).toEqual({
      search_team_slugs: ["existing-team"],
      search_user_subjects: [],
    });
    expect(plan.risk_facts.added_team_slugs).toEqual(["new-team"]);
    expect(plan.risk_facts).not.toHaveProperty("estimated_items");
  });

  it("applies Search revocations immediately while a replacement audience is pending", () => {
    const plan = planRagPublication({
      settings: settings(),
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: {
        search_team_slugs: ["removed-team"],
        search_user_subjects: [],
      },
      requestedState: {
        search_team_slugs: ["new-team"],
        search_user_subjects: [],
      },
      ownerTeamSlug: "owner-team",
    });

    expect(plan.requires_approval).toBe(true);
    expect(plan.effective_state).toEqual({
      search_team_slugs: [],
      search_user_subjects: [],
    });
  });

  it("keeps company-wide Search active until its removal is approved", () => {
    const plan = planRagPublication({
      settings: settings({
        rag_reviewer_team_delegations: {
          everyone: ["company-reviewers"],
        },
      }),
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: {
        search_team_slugs: ["everyone", "project-team"],
        search_user_subjects: [],
      },
      requestedState: {
        search_team_slugs: ["project-team"],
        search_user_subjects: [],
      },
      ownerTeamSlug: "owner-team",
    });

    expect(plan.requires_approval).toBe(true);
    expect(plan.effective_state).toEqual({
      search_team_slugs: ["everyone", "project-team"],
      search_user_subjects: [],
    });
    expect(plan.risk_facts.removed_team_slugs).toEqual(["everyone"]);
    expect(plan.risk_facts.target_team_slugs).toEqual(["everyone"]);
    expect(plan.risk_facts.reasons).toContain(
      "organization-wide audience removal",
    );
    expect(plan.approver_team_slugs).toEqual(["company-reviewers"]);
  });

  it("still applies an ordinary Search removal immediately", () => {
    const plan = planRagPublication({
      settings: settings(),
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: {
        search_team_slugs: ["project-team"],
        search_user_subjects: [],
      },
      requestedState: {
        search_team_slugs: [],
        search_user_subjects: [],
      },
      ownerTeamSlug: "owner-team",
    });

    expect(plan.requires_approval).toBe(false);
    expect(plan.effective_state).toEqual({
      search_team_slugs: [],
      search_user_subjects: [],
    });
  });

  it("publishes an ordinary management-owner team immediately", () => {
    const plan = planRagPublication({
      settings: settings(),
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: { search_team_slugs: [], search_user_subjects: [] },
      requestedState: {
        search_team_slugs: ["owner-team"],
        search_user_subjects: [],
      },
      ownerTeamSlug: "owner-team",
    });

    expect(plan.requires_approval).toBe(false);
  });

  it("does not let an organization-wide management owner bypass publication review", () => {
    const plan = planRagPublication({
      settings: settings(),
      requester: REQUESTER,
      requesterTeamSlugs: ["everyone"],
      currentState: { search_team_slugs: [], search_user_subjects: [] },
      requestedState: {
        search_team_slugs: ["everyone"],
        search_user_subjects: [],
      },
      ownerTeamSlug: "everyone",
    });

    expect(plan.requires_approval).toBe(true);
    expect(plan.effective_state).toEqual({
      search_team_slugs: [],
      search_user_subjects: [],
    });
    expect(plan.approver_team_slugs).toEqual([]);
  });

  it("holds new collection sources while preserving its existing publication", () => {
    const plan = planRagCollectionPublication({
      settings: settings(),
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: ["search-team"],
        global_read: false,
        source_ids: ["source-existing"],
      },
      requestedState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: ["search-team"],
        global_read: false,
        source_ids: ["source-existing", "source-new"],
      },
    });

    expect(plan.requires_approval).toBe(true);
    expect(plan.effective_state).toEqual({
      maintainer_team_slugs: ["owner-team"],
      reader_team_slugs: ["search-team"],
      global_read: false,
      source_ids: ["source-existing"],
    });
  });

  it("reviews source additions to Everyone even when Everyone is also an Owner", () => {
    const plan = planRagCollectionPublication({
      settings: settings(),
      requester: REQUESTER,
      requesterTeamSlugs: ["everyone"],
      currentState: {
        maintainer_team_slugs: ["everyone"],
        reader_team_slugs: ["everyone"],
        global_read: false,
        source_ids: ["source-existing"],
      },
      requestedState: {
        maintainer_team_slugs: ["everyone"],
        reader_team_slugs: ["everyone"],
        global_read: false,
        source_ids: ["source-existing", "source-new"],
      },
    });

    expect(plan.requires_approval).toBe(true);
    expect(plan.effective_state).toEqual({
      maintainer_team_slugs: ["everyone"],
      reader_team_slugs: ["everyone"],
      global_read: false,
      source_ids: ["source-existing"],
    });
  });

  it("keeps company-wide collection Search active until removal is approved", () => {
    const plan = planRagCollectionPublication({
      settings: settings(),
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: ["everyone", "project-team"],
        global_read: false,
        source_ids: ["source-primary"],
      },
      requestedState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: ["project-team"],
        global_read: false,
        source_ids: ["source-primary"],
      },
    });

    expect(plan.requires_approval).toBe(true);
    expect(plan.effective_state).toEqual({
      maintainer_team_slugs: ["owner-team"],
      reader_team_slugs: ["everyone", "project-team"],
      global_read: false,
      source_ids: ["source-primary"],
    });
    expect(plan.risk_facts.removed_team_slugs).toEqual(["everyone"]);
  });

  it("keeps global collection Search active until removal is approved", () => {
    const plan = planRagCollectionPublication({
      settings: settings(),
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: [],
        global_read: true,
        source_ids: ["source-primary"],
      },
      requestedState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: [],
        global_read: false,
        source_ids: ["source-primary"],
      },
    });

    expect(plan.requires_approval).toBe(true);
    expect(plan.effective_state).toEqual({
      maintainer_team_slugs: ["owner-team"],
      reader_team_slugs: [],
      global_read: true,
      source_ids: ["source-primary"],
    });
    expect(plan.risk_facts.removed_team_slugs).toEqual(["everyone"]);
  });

  it("keeps a datasource in a company-wide collection until removal is approved", () => {
    const plan = planRagCollectionPublication({
      settings: settings(),
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: ["everyone"],
        global_read: false,
        source_ids: ["source-primary", "source-secondary"],
      },
      requestedState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: ["everyone"],
        global_read: false,
        source_ids: ["source-primary"],
      },
    });

    expect(plan.requires_approval).toBe(true);
    expect(plan.effective_state).toEqual({
      maintainer_team_slugs: ["owner-team"],
      reader_team_slugs: ["everyone"],
      global_read: false,
      source_ids: ["source-primary", "source-secondary"],
    });
    expect(plan.risk_facts.removed_source_ids).toEqual(["source-secondary"]);
  });

  it("removes a datasource from an owner-only collection immediately", () => {
    const plan = planRagCollectionPublication({
      settings: settings(),
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: [],
        global_read: false,
        source_ids: ["source-primary", "source-secondary"],
      },
      requestedState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: [],
        global_read: false,
        source_ids: ["source-primary"],
      },
    });

    expect(plan.requires_approval).toBe(false);
    expect(plan.effective_state).toEqual({
      maintainer_team_slugs: ["owner-team"],
      reader_team_slugs: [],
      global_read: false,
      source_ids: ["source-primary"],
    });
  });

  it("keeps existing collection Owners effective until a broad ownership change is approved", () => {
    const plan = planRagCollectionPublication({
      settings: settings(),
      requester: REQUESTER,
      requesterTeamSlugs: ["current-owner"],
      currentState: {
        maintainer_team_slugs: ["current-owner"],
        reader_team_slugs: ["search-team"],
        global_read: false,
        source_ids: ["source-existing"],
      },
      requestedState: {
        maintainer_team_slugs: ["new-owner"],
        reader_team_slugs: ["search-team"],
        global_read: false,
        source_ids: ["source-existing"],
      },
    });

    expect(plan.requires_approval).toBe(true);
    expect(plan.effective_state).toEqual({
      maintainer_team_slugs: ["current-owner"],
      reader_team_slugs: ["search-team"],
      global_read: false,
      source_ids: ["source-existing"],
    });
    expect(plan.risk_facts.reasons).toContain(
      "collection ownership changed while Search is broadly shared",
    );
  });

  it("requires connector review when provider membership is unknown", () => {
    const plan = planConnectorPublication({
      settings: settings({
        thresholds: {
          ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS.thresholds,
          slack_channel_members_without_approval: 25,
        },
      }),
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      resourceKind: "slack_channel",
      requestedState: { team_slug: "owner-team" },
      targetTeamSlug: "owner-team",
    });

    expect(plan.requires_approval).toBe(true);
    expect(plan.risk_facts.reasons).toContain("audience size is unknown");
  });

  it("configures Slack and Webex review independently", () => {
    const policy = settings({
      require_slack_onboarding_approval: false,
      require_webex_onboarding_approval: true,
    });
    const common = {
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      requestedState: { team_slug: "owner-team" },
      targetTeamSlug: "owner-team",
    };

    expect(planConnectorPublication({
      ...common,
      resourceKind: "slack_channel",
    }).requires_approval).toBe(false);
    expect(planConnectorPublication({
      ...common,
      resourceKind: "webex_space",
    }).requires_approval).toBe(true);
  });

  it("uses Webex reviewers without RAG reviewer rules", () => {
    const plan = planConnectorPublication({
      settings: settings({
        webex_reviewer_team_slugs: ["webex-reviewers"],
        rag_reviewer_team_slugs: ["rag-reviewers"],
        rag_reviewer_team_delegations: {
          "target-team": ["target-rag-reviewers"],
        },
      }),
      requester: REQUESTER,
      requesterTeamSlugs: ["target-team"],
      resourceKind: "webex_space",
      requestedState: { team_slug: "target-team" },
      targetTeamSlug: "target-team",
      memberCount: 10,
    });

    expect(plan.approver_team_slugs).toEqual(["webex-reviewers"]);
  });

  it("uses Slack reviewers independently from Webex reviewers", () => {
    const plan = planConnectorPublication({
      settings: settings({
        slack_reviewer_user_subjects: ["slack-reviewer"],
        webex_reviewer_user_subjects: ["webex-reviewer"],
      }),
      requester: REQUESTER,
      requesterTeamSlugs: ["target-team"],
      resourceKind: "slack_channel",
      requestedState: { team_slug: "target-team" },
      targetTeamSlug: "target-team",
      memberCount: 10,
    });

    expect(plan.approver_user_subjects).toEqual(["slack-reviewer"]);
  });

  it("does not apply RAG trusted-publisher exceptions to connector onboarding", () => {
    const plan = planConnectorPublication({
      settings: settings({
        trusted_publisher_subjects: [REQUESTER.subject],
        slack_reviewer_team_slugs: ["slack-reviewers"],
      }),
      requester: REQUESTER,
      requesterTeamSlugs: [],
      resourceKind: "slack_channel",
      requestedState: { team_slug: "owner-team" },
      targetTeamSlug: "owner-team",
      memberCount: 10,
    });

    expect(plan.requires_approval).toBe(true);
    expect(plan.approver_team_slugs).toEqual(["slack-reviewers"]);
    expect(plan.risk_facts.organization_wide).toBe(false);
  });

  it("applies a collection team share immediately when the sharing rule is off, but still reviews Everyone", () => {
    const policy = settings({
      rules: {
        ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS.rules,
        rag_collection_sharing: { required: false, team_slugs: [] },
      },
    });
    const teamShare = planRagCollectionPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: [],
        global_read: false,
        source_ids: [],
      },
      requestedState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: ["finance-team"],
        global_read: false,
        source_ids: [],
      },
    });
    expect(teamShare.requires_approval).toBe(false);

    const everyoneShare = planRagCollectionPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: [],
        global_read: false,
        source_ids: [],
      },
      requestedState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: ["everyone"],
        global_read: false,
        source_ids: [],
      },
    });
    expect(everyoneShare.requires_approval).toBe(true);
  });

  it("scopes the collection sharing rule to specific teams", () => {
    const policy = settings({
      rules: {
        ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS.rules,
        rag_collection_sharing: { required: true, team_slugs: ["finance-team"] },
      },
    });
    const base = {
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: [],
        global_read: false,
        source_ids: [],
      },
    };

    const outOfScope = planRagCollectionPublication({
      ...base,
      requestedState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: ["marketing-team"],
        global_read: false,
        source_ids: [],
      },
    });
    expect(outOfScope.requires_approval).toBe(false);

    const inScope = planRagCollectionPublication({
      ...base,
      requestedState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: ["finance-team"],
        global_read: false,
        source_ids: [],
      },
    });
    expect(inScope.requires_approval).toBe(true);
  });

  it("applies a datasource add to a team-shared collection immediately when the source-changes rule is off, but still reviews Everyone", () => {
    const policy = settings({
      rules: {
        ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS.rules,
        rag_collection_datasource_changes: { required: false, team_slugs: [] },
      },
    });
    const teamShared = planRagCollectionPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: ["finance-team"],
        global_read: false,
        source_ids: ["source-existing"],
      },
      requestedState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: ["finance-team"],
        global_read: false,
        source_ids: ["source-existing", "source-new"],
      },
    });
    expect(teamShared.requires_approval).toBe(false);

    const everyoneShared = planRagCollectionPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: ["everyone"],
        global_read: false,
        source_ids: ["source-existing"],
      },
      requestedState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: ["everyone"],
        global_read: false,
        source_ids: ["source-existing", "source-new"],
      },
    });
    expect(everyoneShared.requires_approval).toBe(true);
  });

  it("scopes datasource-change review to collections shared with Everyone, not any specific team", () => {
    const policy = settings({
      rules: {
        ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS.rules,
        rag_collection_datasource_changes: { required: true, team_slugs: ["everyone"] },
      },
    });
    const stateFor = (readerTeamSlugs: string[]) => ({
      currentState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: readerTeamSlugs,
        global_read: false,
        source_ids: ["source-existing"],
      },
      requestedState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: readerTeamSlugs,
        global_read: false,
        source_ids: ["source-existing", "source-new"],
      },
    });

    const teamOnly = planRagCollectionPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      ...stateFor(["finance-team"]),
    });
    expect(teamOnly.requires_approval).toBe(false);

    const everyoneShared = planRagCollectionPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      ...stateFor(["everyone"]),
    });
    expect(everyoneShared.requires_approval).toBe(true);
  });

  it("applies a collection ownership change immediately when the ownership rule is off", () => {
    const policy = settings({
      rules: {
        ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS.rules,
        rag_collection_ownership_changes: { required: false, team_slugs: [] },
      },
    });
    const plan = planRagCollectionPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["current-owner"],
      currentState: {
        maintainer_team_slugs: ["current-owner"],
        reader_team_slugs: ["search-team"],
        global_read: false,
        source_ids: ["source-existing"],
      },
      requestedState: {
        maintainer_team_slugs: ["new-owner"],
        reader_team_slugs: ["search-team"],
        global_read: false,
        source_ids: ["source-existing"],
      },
    });

    expect(plan.requires_approval).toBe(false);
  });

  it("scopes the collection ownership-changes rule to specific teams", () => {
    const policy = settings({
      rules: {
        ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS.rules,
        rag_collection_ownership_changes: { required: true, team_slugs: ["finance-team"] },
      },
    });
    const stateFor = (readerTeamSlug: string) => ({
      currentState: {
        maintainer_team_slugs: ["current-owner"],
        reader_team_slugs: [readerTeamSlug],
        global_read: false,
        source_ids: ["source-existing"],
      },
      requestedState: {
        maintainer_team_slugs: ["new-owner"],
        reader_team_slugs: [readerTeamSlug],
        global_read: false,
        source_ids: ["source-existing"],
      },
    });

    const outOfScope = planRagCollectionPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["current-owner"],
      ...stateFor("marketing-team"),
    });
    expect(outOfScope.requires_approval).toBe(false);

    const inScope = planRagCollectionPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["current-owner"],
      ...stateFor("finance-team"),
    });
    expect(inScope.requires_approval).toBe(true);
  });

  it("scopes datasource sharing review away from a people-only grant", () => {
    const policy = settings({
      rules: {
        ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS.rules,
        rag_datasource_sharing: { required: true, team_slugs: ["finance-team"] },
      },
    });
    const plan = planRagPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: { search_team_slugs: [], search_user_subjects: [] },
      requestedState: {
        search_team_slugs: [],
        search_user_subjects: ["new-person"],
      },
      ownerTeamSlug: "owner-team",
    });

    expect(plan.requires_approval).toBe(false);
  });

  it("still routes an org-wide datasource share to its delegated reviewers when the sharing rule's scope excludes it", () => {
    const policy = settings({
      rules: {
        ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS.rules,
        rag_datasource_sharing: { required: true, team_slugs: ["finance-team"] },
      },
      rag_reviewer_team_delegations: {
        everyone: ["security-team"],
      },
    });
    const plan = planRagPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: { search_team_slugs: [], search_user_subjects: [] },
      requestedState: {
        search_team_slugs: ["everyone"],
        search_user_subjects: [],
      },
      ownerTeamSlug: "owner-team",
    });

    expect(plan.requires_approval).toBe(true);
    expect(plan.risk_facts.target_team_slugs).toEqual(["everyone"]);
    expect(plan.approver_team_slugs).toEqual(["security-team"]);
  });

  it("still routes a team-scoped material datasource change to its delegated reviewers when the sharing rule doesn't also fire", () => {
    const policy = settings({
      rules: {
        ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS.rules,
        rag_datasource_sharing: { required: true, team_slugs: ["other-team"] },
        rag_datasource_material_changes: { required: true, team_slugs: ["finance-team"] },
      },
      rag_reviewer_team_delegations: {
        "finance-team": ["finance-reviewers"],
      },
    });
    const plan = planRagPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: { search_team_slugs: ["finance-team"], search_user_subjects: [] },
      requestedState: { search_team_slugs: ["finance-team"], search_user_subjects: [] },
      ownerTeamSlug: "owner-team",
      materialChange: true,
    });

    expect(plan.requires_approval).toBe(true);
    expect(plan.risk_facts.target_team_slugs).toEqual(["finance-team"]);
    expect(plan.approver_team_slugs).toEqual(["finance-reviewers"]);
  });

  it("still routes a team-scoped collection datasource change to its delegated reviewers when the sharing rule doesn't also fire", () => {
    const policy = settings({
      rules: {
        ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS.rules,
        rag_collection_sharing: { required: true, team_slugs: ["other-team"] },
        rag_collection_datasource_changes: { required: true, team_slugs: ["finance-team"] },
      },
      rag_reviewer_team_delegations: {
        "finance-team": ["finance-reviewers"],
      },
    });
    const plan = planRagCollectionPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: ["finance-team"],
        global_read: false,
        source_ids: ["source-existing"],
      },
      requestedState: {
        maintainer_team_slugs: ["owner-team"],
        reader_team_slugs: ["finance-team"],
        global_read: false,
        source_ids: ["source-existing", "source-new"],
      },
    });

    expect(plan.requires_approval).toBe(true);
    expect(plan.risk_facts.target_team_slugs).toEqual(["finance-team"]);
    expect(plan.approver_team_slugs).toEqual(["finance-reviewers"]);
  });

  it("still routes a team-scoped collection ownership change to its delegated reviewers when the sharing rule doesn't also fire", () => {
    const policy = settings({
      rules: {
        ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS.rules,
        rag_collection_sharing: { required: true, team_slugs: ["other-team"] },
        rag_collection_ownership_changes: { required: true, team_slugs: ["finance-team"] },
      },
      rag_reviewer_team_delegations: {
        "finance-team": ["finance-reviewers"],
      },
    });
    const plan = planRagCollectionPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["current-owner"],
      currentState: {
        maintainer_team_slugs: ["current-owner"],
        reader_team_slugs: ["finance-team"],
        global_read: false,
        source_ids: ["source-existing"],
      },
      requestedState: {
        maintainer_team_slugs: ["new-owner"],
        reader_team_slugs: ["finance-team"],
        global_read: false,
        source_ids: ["source-existing"],
      },
    });

    expect(plan.requires_approval).toBe(true);
    expect(plan.risk_facts.target_team_slugs).toEqual(["finance-team"]);
    expect(plan.approver_team_slugs).toEqual(["finance-reviewers"]);
  });

  it("applies a material datasource change immediately when the material-changes rule is off, but still reviews Everyone", () => {
    const policy = settings({
      rules: {
        ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS.rules,
        rag_datasource_material_changes: { required: false, team_slugs: [] },
      },
    });

    const teamShared = planRagPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: { search_team_slugs: ["other-team"], search_user_subjects: [] },
      requestedState: { search_team_slugs: ["other-team"], search_user_subjects: [] },
      ownerTeamSlug: "owner-team",
      materialChange: true,
    });
    expect(teamShared.requires_approval).toBe(false);

    const everyoneShared = planRagPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: { search_team_slugs: ["everyone"], search_user_subjects: [] },
      requestedState: { search_team_slugs: ["everyone"], search_user_subjects: [] },
      ownerTeamSlug: "owner-team",
      materialChange: true,
    });
    expect(everyoneShared.requires_approval).toBe(true);
  });

  it("scopes the datasource material-changes rule to specific teams", () => {
    const policy = settings({
      rules: {
        ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS.rules,
        rag_datasource_material_changes: { required: true, team_slugs: ["finance-team"] },
      },
    });
    const stateFor = (teamSlug: string) => ({
      currentState: { search_team_slugs: [teamSlug], search_user_subjects: [] },
      requestedState: { search_team_slugs: [teamSlug], search_user_subjects: [] },
    });

    const outOfScope = planRagPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      ownerTeamSlug: "owner-team",
      materialChange: true,
      ...stateFor("marketing-team"),
    });
    expect(outOfScope.requires_approval).toBe(false);

    const inScope = planRagPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      ownerTeamSlug: "owner-team",
      materialChange: true,
      ...stateFor("finance-team"),
    });
    expect(inScope.requires_approval).toBe(true);
  });

  it("scopes datasource material-change review away from a people-only broad audience", () => {
    const policy = settings({
      rules: {
        ...DEFAULT_PUBLICATION_APPROVAL_SETTINGS.rules,
        rag_datasource_material_changes: { required: true, team_slugs: ["finance-team"] },
      },
    });
    const plan = planRagPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: { search_team_slugs: [], search_user_subjects: ["some-person"] },
      requestedState: { search_team_slugs: [], search_user_subjects: ["some-person"] },
      ownerTeamSlug: "owner-team",
      materialChange: true,
    });

    expect(plan.requires_approval).toBe(false);
  });

  it("does not require Slack review outside the configured onboarding team scope", () => {
    const policy = settings({
      slack_onboarding_team_slugs: ["approved-team"],
    });

    const outOfScope = planConnectorPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      resourceKind: "slack_channel",
      requestedState: { team_slug: "owner-team" },
      targetTeamSlug: "owner-team",
      memberCount: 10_000,
    });
    expect(outOfScope.requires_approval).toBe(false);

    const inScope = planConnectorPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["approved-team"],
      resourceKind: "slack_channel",
      requestedState: { team_slug: "approved-team" },
      targetTeamSlug: "approved-team",
      memberCount: 10_000,
    });
    expect(inScope.requires_approval).toBe(true);
  });

  it("does not require Webex review outside the configured onboarding team scope", () => {
    const policy = settings({
      webex_onboarding_team_slugs: ["approved-team"],
    });

    const outOfScope = planConnectorPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      resourceKind: "webex_space",
      requestedState: { team_slug: "owner-team" },
      targetTeamSlug: "owner-team",
      memberCount: 10_000,
    });
    expect(outOfScope.requires_approval).toBe(false);

    const inScope = planConnectorPublication({
      settings: policy,
      requester: REQUESTER,
      requesterTeamSlugs: ["approved-team"],
      resourceKind: "webex_space",
      requestedState: { team_slug: "approved-team" },
      targetTeamSlug: "approved-team",
      memberCount: 10_000,
    });
    expect(inScope.requires_approval).toBe(true);
  });
});

describe("publication approval settings", () => {
  it("normalizes wildcard delegation and rejects malformed entries", () => {
    const normalized = normalizePublicationApprovalSettings({
      approver_team_delegations: {
        "*": ["fallback-approvers"],
        "target-team": ["target-approvers", "target-approvers"],
        "bad target": ["ignored"],
      },
    });

    expect(normalized.rag_reviewer_team_delegations).toEqual({
      "*": ["fallback-approvers"],
      "target-team": ["target-approvers"],
    });
  });

  it("maps legacy reviewers to each independent review area", () => {
    const normalized = normalizePublicationApprovalSettings({
      default_approver_team_slugs: ["legacy-reviewers"],
      default_approver_user_subjects: ["legacy-reviewer"],
    });

    expect(normalized.rag_reviewer_team_slugs).toEqual(["legacy-reviewers"]);
    expect(normalized.slack_reviewer_team_slugs).toEqual(["legacy-reviewers"]);
    expect(normalized.webex_reviewer_team_slugs).toEqual(["legacy-reviewers"]);
    expect(normalized.rag_reviewer_user_subjects).toEqual(["legacy-reviewer"]);
    expect(normalized.slack_reviewer_user_subjects).toEqual(["legacy-reviewer"]);
    expect(normalized.webex_reviewer_user_subjects).toEqual(["legacy-reviewer"]);
  });

  it("allows administrators to clear the organization-wide team aliases", () => {
    const normalized = normalizePublicationApprovalSettings({
      organization_wide_team_slugs: [],
    });

    expect(normalized.organization_wide_team_slugs).toEqual([]);
  });

  it("maps the first local policy shape to the independent switches", () => {
    const normalized = normalizePublicationApprovalSettings({
      enabled: false,
      require_connector_onboarding_approval: true,
    });

    expect(normalized.require_rag_publication_approval).toBe(false);
    expect(normalized.require_slack_onboarding_approval).toBe(false);
    expect(normalized.require_webex_onboarding_approval).toBe(false);
  });

  it("fills in default rules (required, any team) for documents saved before rules existed", () => {
    const normalized = normalizePublicationApprovalSettings({
      require_rag_publication_approval: true,
    });

    expect(normalized.rules).toEqual(
      DEFAULT_PUBLICATION_APPROVAL_SETTINGS.rules,
    );
    expect(normalized.slack_onboarding_team_slugs).toEqual([]);
    expect(normalized.webex_onboarding_team_slugs).toEqual([]);
  });

  it("normalizes only the rules that are present, keeping others at their defaults", () => {
    const normalized = normalizePublicationApprovalSettings({
      rules: {
        rag_collection_sharing: { required: false, team_slugs: ["Finance-Team"] },
      },
    });

    expect(normalized.rules.rag_collection_sharing).toEqual({
      required: false,
      team_slugs: ["finance-team"],
    });
    expect(normalized.rules.rag_collection_datasource_changes).toEqual(
      DEFAULT_PUBLICATION_APPROVAL_SETTINGS.rules.rag_collection_datasource_changes,
    );
  });
});
