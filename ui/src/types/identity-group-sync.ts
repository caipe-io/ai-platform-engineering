export interface IdentityGroupSyncTuple {
  user: string;
  relation: string;
  object: string;
}

export type IdentityProviderType = "okta" | "active_directory" | "oidc_claims";

export type IdentityProviderStatus =
  | "not_configured"
  | "configured"
  | "healthy"
  | "degraded"
  | "disabled";

export interface IdentityProvider {
  id: string;
  type: IdentityProviderType;
  display_name: string;
  status: IdentityProviderStatus;
  last_checked_at?: string;
  capabilities: string[];
}

export type IdentityGroupSyncRuleReviewStatus =
  | "draft"
  | "dry_run_required"
  | "reviewed"
  | "enabled"
  | "disabled";

export type TeamRelationshipRole = "member" | "admin";

export interface IdentityGroupSyncRule {
  id: string;
  provider_id: string;
  name: string;
  priority: number;
  enabled: boolean;
  review_status: IdentityGroupSyncRuleReviewStatus;
  include_patterns: string[];
  exclude_patterns: string[];
  team_name_template: string;
  team_slug_template: string;
  role_map: Record<string, TeamRelationshipRole>;
  auto_create_team: boolean;
  default_relationship_policy_ids?: string[];
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
}

export type ExternalGroupStatus =
  | "active"
  | "inactive"
  | "deleted"
  | "renamed"
  | "unreadable"
  | "unknown";

export interface ExternalGroup {
  provider_id: string;
  external_group_id: string;
  display_name: string;
  normalized_name: string;
  status: ExternalGroupStatus;
  member_count?: number;
  last_seen_at?: string;
  metadata?: Record<string, string | number | boolean>;
}

export type TeamMembershipSourceType =
  | "manual"
  | "okta"
  | "active_directory"
  | "oidc_claim"
  | "bootstrap"
  | "migration"
  | "policy_rule";

export type TeamMembershipSourceStatus =
  | "active"
  | "stale"
  | "pending_identity_link"
  | "disabled_user"
  | "removed"
  | "error";

export interface TeamMembershipSource {
  team_id: string;
  team_slug: string;
  user_subject?: string;
  user_email?: string;
  display_name?: string;
  relationship: TeamRelationshipRole;
  source_type: TeamMembershipSourceType;
  provider_id?: string;
  external_group_id?: string;
  sync_rule_id?: string;
  managed: boolean;
  status: TeamMembershipSourceStatus;
  first_seen_at?: string;
  last_seen_at?: string;
  last_applied_at?: string;
  created_by?: string;
  created_at: string;
  removed_by?: string;
  removed_at?: string;
}

export type IdentityGroupSyncSafetyWarningCode =
  | "large_membership_removal"
  | "admin_membership_removal"
  | "orphaned_team_membership";

export interface IdentityGroupSyncSafetyWarning {
  code: IdentityGroupSyncSafetyWarningCode;
  severity: "warning" | "blocker";
  message: string;
  requires_acknowledgement: boolean;
  team_slug?: string;
  user_identifier?: string;
  affected_count?: number;
}

export interface IdentityGroupSyncDryRunResult {
  matched_groups: ExternalGroup[];
  ignored_groups: ExternalGroup[];
  teams_to_create: Array<{ slug: string; name: string; source_group_id: string }>;
  teams_to_update: Array<{ slug: string; name: string; source_group_id: string }>;
  /**
   * Slugs of existing identity_group_sync teams that are currently
   * `status: "archived"` but regained at least one active managed
   * membership in this sync — the reconciler flips these back to
   * `status: "active"`. Optional so existing plan literals in tests
   * don't need updating.
   */
  teams_to_unarchive?: string[];
  membership_sources_to_refresh: TeamMembershipSource[];
  membership_sources_to_add: TeamMembershipSource[];
  membership_sources_to_remove: TeamMembershipSource[];
  tuple_writes: IdentityGroupSyncTuple[];
  tuple_deletes: IdentityGroupSyncTuple[];
  skipped_users: Array<{ source_group_id: string; user_identifier: string; reason: string }>;
  conflicts: Array<{ source_group_id: string; reason: string }>;
  safety_warnings?: IdentityGroupSyncSafetyWarning[];
}
