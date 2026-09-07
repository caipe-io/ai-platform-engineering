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

  it("reviews a material source change already published through a collection", () => {
    const plan = planRagPublication({
      settings: settings({
        rag_reviewer_team_delegations: {
          "search-team": ["knowledge-approvers"],
        },
      }),
      requester: REQUESTER,
      requesterTeamSlugs: ["owner-team"],
      currentState: { search_team_slugs: [], search_user_subjects: [] },
      requestedState: {
        search_team_slugs: [],
        search_user_subjects: [],
        source_update: { settings: { max_pages: 500 } },
      },
      ownerTeamSlug: "owner-team",
      materialChange: true,
      externalAudienceTeamSlugs: ["search-team"],
      externalBroadAudience: true,
    });

    expect(plan.requires_approval).toBe(true);
    expect(plan.risk_facts.reasons).toContain(
      "source is published through a collection",
    );
    expect(plan.approver_team_slugs).toEqual(["knowledge-approvers"]);
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
});
