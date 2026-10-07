import type {
ExternalGroup,
IdentityGroupSyncDryRunResult,
IdentityGroupSyncRule,
IdentityGroupSyncSafetyWarning,
TeamMembershipSource,
} from "@/types/identity-group-sync";

import { loopYieldEvery, maybeYield } from "./event-loop-yield";
import { evaluateIdentityGroupRules } from "./identity-group-rule-matcher";
import { reconcileTeamMembershipSources } from "./membership-reconciler";

interface ExistingTeam {
  id: string;
  slug: string;
  name: string;
  status?: string;
}

interface ExternalGroupMember {
  subject?: string;
  email: string;
  display_name?: string;
  active: boolean;
}

type ExternalGroupWithMembers = ExternalGroup & { members?: ExternalGroupMember[] };
const LARGE_REMOVAL_WARNING_THRESHOLD = 10;

export interface PlanIdentityGroupSyncInput {
  groups: ExternalGroupWithMembers[];
  rules: IdentityGroupSyncRule[];
  existingTeams: ExistingTeam[];
  existingMembershipSources: TeamMembershipSource[];
  now: string;
  actor: string;
  allowTeamCreation?: boolean;
  /**
   * When true, `groups` is only a subset of the directory (e.g. a group filter
   * was applied), so removals are scoped to the fetched groups only. When false
   * / omitted, `groups` is the complete directory snapshot and a full
   * add+remove reconcile runs.
   */
  partialFetch?: boolean;
}

export function sourceTypeForProvider(providerId: string): TeamMembershipSource["source_type"] {
  if (providerId.startsWith("okta")) return "okta";
  if (providerId.startsWith("ad")) return "active_directory";
  return "oidc_claim";
}

function sourceKey(source: TeamMembershipSource): string {
  return [
    source.team_slug,
    source.user_subject ?? source.user_email ?? "",
    source.relationship,
    source.source_type,
    source.provider_id ?? "",
    source.external_group_id ?? "",
    source.sync_rule_id ?? "",
  ].join("\n");
}

async function buildSafetyWarnings(input: {
  existingSources: TeamMembershipSource[];
  desiredSources: TeamMembershipSource[];
  sourcesToRemove: TeamMembershipSource[];
}): Promise<IdentityGroupSyncSafetyWarning[]> {
  const warnings: IdentityGroupSyncSafetyWarning[] = [];
  if (input.sourcesToRemove.length === 0) return warnings;

  const yieldEvery = loopYieldEvery();
  let processed = 0;

  if (input.sourcesToRemove.length > LARGE_REMOVAL_WARNING_THRESHOLD) {
    warnings.push({
      code: "large_membership_removal",
      severity: "blocker",
      message: `${input.sourcesToRemove.length} managed memberships would be removed by this sync.`,
      requires_acknowledgement: true,
      affected_count: input.sourcesToRemove.length,
    });
  }

  for (const source of input.sourcesToRemove) {
    await maybeYield(++processed, yieldEvery);
    if (source.relationship !== "admin") continue;
    warnings.push({
      code: "admin_membership_removal",
      severity: "blocker",
      message: `Admin membership for ${source.user_email ?? source.user_subject ?? "unknown user"} on team ${source.team_slug} would be removed.`,
      requires_acknowledgement: true,
      team_slug: source.team_slug,
      user_identifier: source.user_email ?? source.user_subject,
    });
  }

  // Precompute the set of team slugs that still have an active managed member
  // after this reconcile, so the orphan check below is an O(1) lookup per
  // removed source instead of an O(removals × activeAfter) nested scan — which
  // at full-directory scale pinned the event loop.
  const removedKeys = new Set(input.sourcesToRemove.map(sourceKey));
  const teamsWithRetainedManagedMember = new Set<string>();
  const addRetained = async (sources: TeamMembershipSource[], requireNotRemoved: boolean) => {
    for (const source of sources) {
      await maybeYield(++processed, yieldEvery);
      if (source.status !== "active" || !source.managed) continue;
      if (requireNotRemoved && removedKeys.has(sourceKey(source))) continue;
      teamsWithRetainedManagedMember.add(source.team_slug);
    }
  };
  await addRetained(input.existingSources, true);
  await addRetained(input.desiredSources, false);

  const orphanWarnedTeams = new Set<string>();
  for (const source of input.sourcesToRemove) {
    await maybeYield(++processed, yieldEvery);
    if (teamsWithRetainedManagedMember.has(source.team_slug)) continue;
    if (orphanWarnedTeams.has(source.team_slug)) continue;
    orphanWarnedTeams.add(source.team_slug);
    warnings.push({
      code: "orphaned_team_membership",
      severity: "warning",
      message: `Team ${source.team_slug} would have no active managed identity-sync memberships in this sync scope; review resource grants for abandoned access.`,
      requires_acknowledgement: true,
      team_slug: source.team_slug,
    });
  }

  return warnings;
}

export async function planIdentityGroupSync(
  input: PlanIdentityGroupSyncInput
): Promise<IdentityGroupSyncDryRunResult> {
  // A full-directory plan iterates over every matched group's members (hundreds
  // of thousands at org scale) with no awaited I/O. Yield to the event loop
  // periodically across these loops so the pod's k8s liveness probe still runs
  // and the pod isn't SIGKILLed mid-plan.
  const yieldEvery = loopYieldEvery();
  let processed = 0;

  const allowTeamCreation = input.allowTeamCreation ?? true;
  const existingTeamBySlug = new Map(input.existingTeams.map((team) => [team.slug, team]));
  const ruleResult = await evaluateIdentityGroupRules({
    groups: input.groups,
    rules: input.rules,
    existingTeamSlugs: input.existingTeams.map((team) => team.slug),
  });

  const teamsToCreateBySlug = new Map<string, { slug: string; name: string; source_group_id: string }>();
  for (const match of ruleResult.matches
    .filter((match) => allowTeamCreation && !existingTeamBySlug.has(match.teamSlug) && match.rule.auto_create_team)
  ) {
    if (teamsToCreateBySlug.has(match.teamSlug)) continue;
    teamsToCreateBySlug.set(match.teamSlug, {
      slug: match.teamSlug,
      name: match.teamName,
      source_group_id: match.group.external_group_id,
    });
  }
  const teams_to_create = Array.from(teamsToCreateBySlug.values());

  const teams_to_update: Array<{ slug: string; name: string; source_group_id: string }> = [];
  for (const match of ruleResult.matches) {
    const existing = existingTeamBySlug.get(match.teamSlug);
    if (existing && existing.name !== match.teamName) {
      if (!teams_to_update.some((t) => t.slug === match.teamSlug)) {
        teams_to_update.push({
          slug: match.teamSlug,
          name: match.teamName,
          source_group_id: match.group.external_group_id,
        });
      }
    }
  }

  const skipped_users: IdentityGroupSyncDryRunResult["skipped_users"] = [];
  const desiredSources: TeamMembershipSource[] = [];

  for (const match of ruleResult.matches) {
    const team = existingTeamBySlug.get(match.teamSlug);
    if (!team && !allowTeamCreation) {
      continue;
    }
    const teamId = team?.id ?? match.teamSlug;
    for (const member of (match.group as ExternalGroupWithMembers).members ?? []) {
      await maybeYield(++processed, yieldEvery);
      if (!member.active) {
        skipped_users.push({
          source_group_id: match.group.external_group_id,
          user_identifier: member.email,
          reason: "inactive_user",
        });
        continue;
      }
      if (!member.subject) {
        skipped_users.push({
          source_group_id: match.group.external_group_id,
          user_identifier: member.email,
          reason: "missing_subject",
        });
        continue;
      }
      desiredSources.push({
        team_id: teamId,
        team_slug: match.teamSlug,
        user_subject: member.subject,
        user_email: member.email,
        display_name: member.display_name,
        relationship: match.relationship,
        source_type: sourceTypeForProvider(match.group.provider_id),
        provider_id: match.group.provider_id,
        external_group_id: match.group.external_group_id,
        sync_rule_id: match.rule.id,
        managed: true,
        status: "active",
        first_seen_at: input.now,
        last_seen_at: input.now,
        created_by: input.actor,
        created_at: input.now,
      });
    }
  }

  // A team can be archived (all managed memberships previously removed) and
  // later regain an active managed member when its Okta group is unarchived
  // or repopulated. Detect that here — before reconciliation — so it applies
  // whether the member is brand new (`sourcesToAdd`) or already stored as
  // active (defensive: an archived team should never retain active sources,
  // but this keeps the check independent of that invariant holding).
  const teamSlugsWithDesiredMembership = new Set(desiredSources.map((s) => s.team_slug));
  const teams_to_unarchive = Array.from(existingTeamBySlug.values())
    .filter((team) => team.status === "archived" && teamSlugsWithDesiredMembership.has(team.slug))
    .map((team) => team.slug);

  const reconciliation = await reconcileTeamMembershipSources({
    existingSources: input.existingMembershipSources,
    desiredSources,
    now: input.now,
    // On a partial (filtered) fetch, only reconcile removals within the groups
    // we actually fetched, so we never drop memberships for unseen groups.
    observedGroupIds: input.partialFetch
      ? new Set(input.groups.map((g) => g.external_group_id))
      : undefined,
  });
  const existingActiveKeys = new Set(
    input.existingMembershipSources
      .filter((s) => s.status === "active")
      .map((s) => sourceKey(s))
  );
  const membership_sources_to_refresh = desiredSources
    .filter((s) => existingActiveKeys.has(sourceKey(s)))
    .map((s) => ({ ...s, last_seen_at: input.now }));

  const safety_warnings = await buildSafetyWarnings({
    existingSources: input.existingMembershipSources,
    desiredSources,
    sourcesToRemove: reconciliation.sourcesToRemove,
  });

  return {
    matched_groups: ruleResult.matches.map((match) => match.group),
    ignored_groups: ruleResult.ignored.map((ignored) => ignored.group),
    teams_to_create,
    teams_to_update,
    teams_to_unarchive,
    membership_sources_to_add: reconciliation.sourcesToAdd,
    membership_sources_to_remove: reconciliation.sourcesToRemove,
    membership_sources_to_refresh,
    tuple_writes: reconciliation.tupleWrites,
    tuple_deletes: reconciliation.tupleDeletes,
    skipped_users,
    conflicts: ruleResult.conflicts.map((conflict) => ({
      source_group_id: conflict.group.external_group_id,
      reason: conflict.reason,
    })),
    safety_warnings,
  };
}
