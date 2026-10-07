import type { Collection,Document } from "mongodb";

import type { IdentityGroupSyncRule,IdentityProvider,TeamMembershipSource } from "@/types/identity-group-sync";
import type { UniversalRebacRelationship,UniversalRebacResourceRef } from "@/types/rbac-universal";

export const RBAC_COLLECTION_NAMES = {
  identityProviders: "identity_providers",
  identityGroupSyncRules: "identity_group_sync_rules",
  identityGroupSyncRuns: "identity_group_sync_runs",
  externalGroups: "external_groups",
  externalGroupTeamLinks: "external_group_team_links",
  teamMembershipSources: "team_membership_sources",
  rebacResources: "rebac_resources",
  rebacRelationships: "rebac_relationships",
  policyRules: "policy_rules",
  policyChangeSets: "policy_change_sets",
  slackChannelAgentRoutes: "slack_channel_agent_routes",
  slackChannelGrants: "slack_channel_grants",
  webexSpaceAgentRoutes: "webex_space_agent_routes",
  webexSpaceGrants: "webex_space_grants",
  webexSpaceTeamMappings: "webex_space_team_mappings",
  webexDirectUserRoutes: "webex_direct_user_routes",
  webexUserMetrics: "webex_user_metrics",
  rebacEnforcementStatus: "rebac_enforcement_status",
  rebacDriftFindings: "rebac_drift_findings",
  userPreferences: "user_preferences",
  idpSyncSettings: "idp_sync_settings",
  idpSyncRuns: "idp_sync_runs",
} as const;

export type RbacCollectionKey = keyof typeof RBAC_COLLECTION_NAMES;
export type RbacCollectionName = (typeof RBAC_COLLECTION_NAMES)[RbacCollectionKey];

export interface ExternalGroupTeamLinkDocument extends Document {
  provider_id: string;
  external_group_id: string;
  sync_rule_id: string;
  team_id: string;
  team_slug: string;
  relationship_role: "member" | "admin";
  status: "active" | "stale" | "conflicted" | "disabled" | "pending_review";
  first_seen_at?: string;
  last_seen_at?: string;
  last_applied_at?: string;
  conflict_reason?: string;
}

export interface RebacResourceDocument extends Document {
  resource_type: UniversalRebacResourceRef["type"];
  resource_id: string;
  display_name: string;
  status: "active" | "disabled" | "archived" | "deleted" | "unknown";
  enforcement_status: "not_gated" | "role_gated" | "rebac_shadowed" | "rebac_enforced" | "deprecated";
  metadata?: Record<string, unknown>;
}

export interface RebacRelationshipDocument extends Document, UniversalRebacRelationship {
  source_type: "manual" | "identity_sync" | "policy_rule" | "migration" | "bootstrap" | "system";
  source_id?: string;
  status: "staged" | "active" | "revoked" | "blocked" | "error";
  created_by?: string;
  created_at: string;
  revoked_by?: string;
  revoked_at?: string;
}

// One settings document per IdP connector (provider_id is the key). Today the
// only implemented connector is "okta"; the schedule/filters below are scoped
// to that connector, not global.
export interface IdpSyncSettings extends Document {
  provider_id: string;
  enabled: boolean;
  /** Okta group filter expression applied to the group listing. */
  group_filter?: string;
  /**
   * "interval" → run every `sync_interval_minutes` (preset: 1h/6h/24h).
   * "cron" → run on the `sync_cron` schedule (standard 5-field cron).
   */
  schedule_mode: "interval" | "cron";
  sync_interval_minutes: number;
  sync_cron?: string;
  updated_by: string;
  updated_at: string;
  /**
   * Scheduler bookkeeping (not user-editable). The UTC minute, as
   * `YYYY-MM-DDTHH:mm`, that the background scheduler last fired a run for this
   * connector. Claimed atomically (compare-and-set) so a given minute fires at
   * most once even when multiple caipe-ui replicas tick concurrently.
   */
  last_fire_minute?: string;
}

// One run record per sync execution, tagged with the connector it ran for.
export interface IdpSyncRun extends Document {
  id: string;
  provider_id: string;
  status: "running" | "success" | "failed" | "partial";
  triggered_by: "schedule" | "manual";
  triggered_by_user?: string;
  // The group filter expression this run used, if any. Surfaced in Sync History
  // so a partial/scoped run is distinguishable from a full directory sync.
  group_filter?: string;
  started_at: string;
  // Liveness heartbeat: the executing process refreshes this periodically.
  // A `running` run whose heartbeat goes stale is treated as interrupted (the
  // pod/process died), which both unblocks new syncs and clears the UI status.
  // This is heartbeat- not elapsed-time-based, so a slow-but-alive sync is
  // never falsely reaped.
  heartbeat_at?: string;
  completed_at?: string;
  groups_fetched?: number;
  groups_matched?: number;
  membership_sources_added?: number;
  membership_sources_removed?: number;
  error_message?: string;
  // Live progress for the member-scan phase (the long part), shown on a
  // `running` row in Sync History. `progress_scanned` of `progress_total`
  // groups have had their members resolved.
  progress_total?: number;
  progress_scanned?: number;
}

export function getRbacCollectionName(key: RbacCollectionKey): RbacCollectionName {
  return RBAC_COLLECTION_NAMES[key];
}

export function listRbacCollectionNames(): RbacCollectionName[] {
  return Array.from(new Set(Object.values(RBAC_COLLECTION_NAMES)));
}

export async function getRbacCollection<T extends Document = Document>(
  key: RbacCollectionKey
): Promise<Collection<T>> {
  const { getCollection } = await import("@/lib/mongodb");
  return getCollection<T>(getRbacCollectionName(key));
}

export function getIdentityProvidersCollection(): Promise<Collection<IdentityProvider & Document>> {
  return getRbacCollection<IdentityProvider & Document>("identityProviders");
}

export function getIdentityGroupSyncRulesCollection(): Promise<
  Collection<IdentityGroupSyncRule & Document>
> {
  return getRbacCollection<IdentityGroupSyncRule & Document>("identityGroupSyncRules");
}

export function getTeamMembershipSourcesCollection(): Promise<
  Collection<TeamMembershipSource & Document>
> {
  return getRbacCollection<TeamMembershipSource & Document>("teamMembershipSources");
}

export function getRebacRelationshipsCollection(): Promise<Collection<RebacRelationshipDocument>> {
  return getRbacCollection<RebacRelationshipDocument>("rebacRelationships");
}
