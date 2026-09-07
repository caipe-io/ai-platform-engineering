// Team types for team management and sharing

import type { TeamMembershipSource } from "./identity-group-sync";

export interface Team {
  _id: string;
  /**
   * Short, URL-safe identifier used as the team's OpenFGA object id
   * (`team:<slug>`) and the channel/space mapping foreign key in
   * `channel_team_mappings` and `webex_space_team_mappings`. Lowercase
   * alphanumerics + hyphens, max 63 chars. Auto-derived from `name`
   * on team creation; immutable afterwards because renaming the slug
   * would orphan every OpenFGA tuple and every channel/space mapping
   * row pinned to the team.
   *
   * (Phase 3 of spec 2026-05-24-derive-team-from-channel removed the
   * per-team Keycloak client scope; `slug` no longer participates in
   * any Keycloak object name or JWT claim.)
   */
  slug: string;
  name: string;
  description?: string;
  source?: 'manual' | 'identity_sync' | 'identity_group_sync' | 'bootstrap' | 'migration';
  status?: 'active' | 'archived' | 'pending_review' | 'disabled';
  owner_id: string; // Creator metadata; authorization comes from team membership roles
  created_by?: string;
  updated_by?: string;
  created_at: Date;
  updated_at: Date;
  members: TeamMember[];
  membership_sources?: TeamMembershipSource[];
  /**
   * Distinct active member count, decorated by GET /api/admin/teams from the
   * canonical `team_membership_sources` store. Optional because locally-built
   * Team objects (pre server round-trip) won't have it.
   */
  member_count?: number;
  /**
   * Owned + shared resource counts decorated by GET /api/admin/teams, read
   * live from OpenFGA (the single source of truth for team↔resource grants).
   * Optional for the same reason as `member_count`.
   */
  agent_count?: number;
  skill_count?: number;
  workflow_count?: number;
  kb_count?: number;
  keycloak_roles?: string[];
  /**
   * Optional Baseline FGA profile overrides. When present, login and admin
   * reconciliation materialize this team's selected profile instead of the
   * global org-member/org-admin profile for matching team users.
   */
  baseline_profile_overrides?: {
    member_profile_id?: string;
    admin_profile_id?: string;
  };
  /**
   * Spec 098 US9 — Slack channels assigned to this team. Each row mirrors a
   * `channel_team_mappings` document. Agent/resource access is managed by
   * Slack channel ReBAC grants rather than a single bound agent.
   */
  slack_channels?: Array<{
    slack_channel_id: string;
    channel_name: string;
    slack_workspace_id?: string;
  }>;
  /**
   * Webex spaces assigned to this team. Mirrors `webex_space_team_mappings`;
   * resource access remains managed through Webex space ReBAC grants.
   */
  webex_spaces?: Array<{
    space_id: string;
    space_name: string;
    workspace_id?: string;
  }>;
  metadata?: {
    department?: string;
    tags?: string[];
  };
  /**
   * Per-row management gate decorated by GET /api/admin/teams. True for
   * org/super admins on every team and for team admins on teams they own.
   * Drives the "Manage team" vs "View team" affordance on the admin team
   * card. Optional because callers may build Team objects locally before
   * the server round-trip; a missing flag means "no edit privilege".
   */
  can_manage?: boolean;
}

export interface TeamMember {
  user_id: string; // User email
  role: 'owner' | 'admin' | 'member';
  added_at: Date;
  added_by: string; // User email
}

export interface CreateTeamRequest {
  name: string;
  /**
   * Optional explicit slug. If omitted, the Web UI backend derives it from `name`
   * (lowercase, non-alphanumerics → `-`, deduped, trimmed).
   */
  slug?: string;
  description?: string;
  members?: string[]; // Array of user emails
}

export interface UpdateTeamRequest {
  name?: string;
  description?: string;
}

export interface AddTeamMemberRequest {
  user_id: string; // User email
  role?: 'admin' | 'member';
}
