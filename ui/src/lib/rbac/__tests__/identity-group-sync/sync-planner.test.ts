import type {
  ExternalGroup,
  IdentityGroupSyncRule,
  TeamMembershipSource,
} from "@/types/identity-group-sync";

import { planIdentityGroupSync } from "../../identity-group-sync-planner";

const rule: IdentityGroupSyncRule = {
  id: "rule-platform",
  provider_id: "oidc-claims",
  name: "Platform groups",
  priority: 10,
  enabled: true,
  review_status: "enabled",
  include_patterns: ["^Engineering (?<team>Platform) (?<role>Users)$"],
  exclude_patterns: [],
  team_name_template: "{{team}}",
  team_slug_template: "{{team}}",
  role_map: { Users: "member" },
  auto_create_team: true,
  created_by: "admin@example.test",
  created_at: "2026-05-12T00:00:00.000Z",
  updated_by: "admin@example.test",
  updated_at: "2026-05-12T00:00:00.000Z",
};

const group: ExternalGroup & {
  members: Array<{ subject?: string; email: string; display_name: string; active: boolean }>;
} = {
  provider_id: "oidc-claims",
  external_group_id: "gid-caipe-users",
  display_name: "Engineering Platform Users",
  normalized_name: "engineering platform users",
  status: "active",
  members: [
    {
      subject: "bob-sub",
      email: "bob@example.test",
      display_name: "Bob User",
      active: true,
    },
    {
      email: "unlinked@example.test",
      display_name: "Unlinked User",
      active: true,
    },
  ],
};

describe("identity group sync dry-run planner", () => {
  it("plans team creation, membership sources, skipped users, and member tuples", async () => {
    const result = await planIdentityGroupSync({
      groups: [group],
      rules: [rule],
      existingTeams: [],
      existingMembershipSources: [],
      now: "2026-05-12T01:00:00.000Z",
      actor: "admin@example.test",
    });

    expect(result.teams_to_create).toEqual([
      { slug: "platform", name: "Platform", source_group_id: "gid-caipe-users" },
    ]);
    expect(result.membership_sources_to_add).toEqual([
      expect.objectContaining({
        team_slug: "platform",
        user_subject: "bob-sub",
        user_email: "bob@example.test",
        display_name: "Bob User",
        relationship: "member",
        source_type: "oidc_claim",
        managed: true,
        status: "active",
      }),
    ]);
    expect(result.skipped_users).toEqual([
      {
        source_group_id: "gid-caipe-users",
        user_identifier: "unlinked@example.test",
        reason: "missing_subject",
      },
    ]);
    expect(result.tuple_writes).toEqual([
      { user: "user:bob-sub", relation: "member", object: "team:platform" },
    ]);
  });

  it("queues a team rename when the stored team name differs from the IdP group name", async () => {
    const result = await planIdentityGroupSync({
      groups: [group],
      rules: [rule],
      existingTeams: [{ id: "platform-id", slug: "platform", name: "Old Platform Name" }],
      existingMembershipSources: [],
      now: "2026-05-12T01:00:00.000Z",
      actor: "admin@example.test",
    });

    expect(result.teams_to_update).toEqual([
      { slug: "platform", name: "Platform", source_group_id: "gid-caipe-users" },
    ]);
    expect(result.teams_to_create).toEqual([]);
  });

  it("flags an archived team for unarchive when its Okta group regains an active managed member", async () => {
    const result = await planIdentityGroupSync({
      groups: [group],
      rules: [rule],
      existingTeams: [{ id: "platform-id", slug: "platform", name: "Platform", status: "archived" }],
      existingMembershipSources: [],
      now: "2026-05-12T01:00:00.000Z",
      actor: "admin@example.test",
    });

    expect(result.teams_to_unarchive).toEqual(["platform"]);
    expect(result.membership_sources_to_add).toEqual(
      expect.arrayContaining([expect.objectContaining({ team_slug: "platform", user_subject: "bob-sub" })])
    );
  });

  it("does not flag an already-active team for unarchive", async () => {
    const result = await planIdentityGroupSync({
      groups: [group],
      rules: [rule],
      existingTeams: [{ id: "platform-id", slug: "platform", name: "Platform", status: "active" }],
      existingMembershipSources: [],
      now: "2026-05-12T01:00:00.000Z",
      actor: "admin@example.test",
    });

    expect(result.teams_to_unarchive).toEqual([]);
  });

  it("does not flag an archived team for unarchive when its group has no active matched members", async () => {
    const inactiveGroup = {
      ...group,
      members: [{ email: "inactive@example.test", display_name: "Inactive User", active: false }],
    };

    const result = await planIdentityGroupSync({
      groups: [inactiveGroup],
      rules: [rule],
      existingTeams: [{ id: "platform-id", slug: "platform", name: "Platform", status: "archived" }],
      existingMembershipSources: [],
      now: "2026-05-12T01:00:00.000Z",
      actor: "admin@example.test",
    });

    expect(result.teams_to_unarchive).toEqual([]);
  });

  it("stamps last_seen_at on membership_sources_to_refresh for unchanged active memberships", async () => {
    const existingSource: TeamMembershipSource = {
      team_id: "platform-id",
      team_slug: "platform",
      user_subject: "bob-sub",
      user_email: "bob@example.test",
      display_name: "Bob User",
      relationship: "member",
      source_type: "oidc_claim",
      provider_id: "oidc-claims",
      external_group_id: "gid-caipe-users",
      sync_rule_id: "rule-platform",
      managed: true,
      status: "active",
      first_seen_at: "2026-04-01T00:00:00.000Z",
      last_seen_at: "2026-04-01T00:00:00.000Z",
      created_by: "admin@example.test",
      created_at: "2026-04-01T00:00:00.000Z",
    };

    const result = await planIdentityGroupSync({
      groups: [group],
      rules: [rule],
      existingTeams: [{ id: "platform-id", slug: "platform", name: "Platform" }],
      existingMembershipSources: [existingSource],
      now: "2026-05-12T01:00:00.000Z",
      actor: "admin@example.test",
    });

    expect(result.membership_sources_to_refresh).toEqual([
      expect.objectContaining({
        team_slug: "platform",
        user_subject: "bob-sub",
        last_seen_at: "2026-05-12T01:00:00.000Z",
      }),
    ]);
    expect(result.membership_sources_to_add).toEqual([]);
  });

  it("surfaces safety warnings for disruptive managed membership removals", async () => {
    const existingSources = [
      {
        team_id: "platform-id",
        team_slug: "platform",
        user_subject: "admin-sub",
        user_email: "admin@example.test",
        relationship: "admin" as const,
        source_type: "oidc_claim" as const,
        provider_id: "oidc-claims",
        external_group_id: "Engineering Platform Admins",
        sync_rule_id: "rule-platform-admins",
        managed: true,
        status: "active" as const,
        created_at: "2026-05-12T00:00:00.000Z",
      },
    ];

    const result = await planIdentityGroupSync({
      groups: [],
      rules: [rule],
      existingTeams: [{ id: "platform-id", slug: "platform", name: "Platform" }],
      existingMembershipSources: existingSources,
      now: "2026-05-12T01:00:00.000Z",
      actor: "admin@example.test",
    });

    expect(result.membership_sources_to_remove).toHaveLength(1);
    expect(result.safety_warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "admin_membership_removal",
          severity: "blocker",
          requires_acknowledgement: true,
          team_slug: "platform",
          user_identifier: "admin@example.test",
        }),
        expect.objectContaining({
          code: "orphaned_team_membership",
          severity: "warning",
          requires_acknowledgement: true,
          team_slug: "platform",
        }),
      ])
    );
  });

  it("deduplicates team creation when multiple claim groups target the same missing team", async () => {
    const adminGroup = {
      ...group,
      external_group_id: "gid-caipe-admins",
      display_name: "Engineering Platform Admins",
      normalized_name: "engineering platform admins",
    };
    const adminRule = {
      ...rule,
      include_patterns: ["^Engineering (?<team>Platform) (?<role>Admins|Users)$"],
      role_map: { Admins: "admin", Users: "member" },
    };

    const result = await planIdentityGroupSync({
      groups: [group, adminGroup],
      rules: [adminRule],
      existingTeams: [],
      existingMembershipSources: [],
      now: "2026-05-12T01:00:00.000Z",
      actor: "admin@example.test",
    });

    expect(result.teams_to_create).toEqual([
      { slug: "platform", name: "Platform", source_group_id: "gid-caipe-users" },
    ]);
    expect(result.membership_sources_to_add).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ team_slug: "platform", relationship: "member" }),
        expect.objectContaining({ team_slug: "platform", relationship: "admin" }),
      ])
    );
  });
});
