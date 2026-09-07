import { ApiError } from "@/lib/api-error";
import { getCollection } from "@/lib/mongodb";
import type { OpenFgaTupleKey } from "@/lib/rbac/openfga";
import { resolveUserIdentitiesBySubject } from "@/lib/rbac/user-identity-directory";
import { reconcileTupleDiff } from "@/lib/authz";
import type { PublicationApprovalSettings } from "@/types/publication-approval";

export const PUBLICATION_POLICY_ID = "publication";
export const PUBLICATION_SETTINGS_FIELD = "publication_approval";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

export const DEFAULT_PUBLICATION_APPROVAL_SETTINGS: PublicationApprovalSettings = {
  require_rag_publication_approval: true,
  require_slack_onboarding_approval: true,
  require_webex_onboarding_approval: true,
  allow_organization_wide_self_approval: false,
  trusted_publishers_bypass: true,
  trusted_publisher_subjects: [],
  trusted_publisher_team_slugs: [],
  organization_wide_team_slugs: ["everyone"],
  rag_reviewer_team_slugs: [],
  rag_reviewer_user_subjects: [],
  slack_reviewer_team_slugs: [],
  slack_reviewer_user_subjects: [],
  webex_reviewer_team_slugs: [],
  webex_reviewer_user_subjects: [],
  rag_reviewer_team_delegations: {},
  rag_reviewer_user_delegations: {},
  thresholds: {
    slack_channel_members_without_approval: 0,
    webex_space_members_without_approval: 0,
  },
};

interface PlatformConfigPublicationDocument {
  _id: string;
  publication_approval?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function boundedInteger(value: unknown, fallback: number, maximum = 1_000_000): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum
    ? value
    : fallback;
}

function stringList(value: unknown, options: { lowerCase?: boolean } = {}): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = value.flatMap((item) => {
    if (typeof item !== "string") return [];
    const trimmed = item.trim();
    if (!trimmed || !ID_PATTERN.test(trimmed)) return [];
    return [options.lowerCase ? trimmed.toLowerCase() : trimmed];
  });
  return Array.from(new Set(normalized)).slice(0, 200);
}

function normalizeDelegations(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [target, rawApprovers] of Object.entries(value)) {
    const normalizedTarget = target.trim();
    if (normalizedTarget !== "*" && !ID_PATTERN.test(normalizedTarget)) continue;
    const approvers = stringList(rawApprovers);
    if (approvers.length > 0) result[normalizedTarget] = approvers;
  }
  return result;
}

function mergeSettingsUpdate(
  previous: PublicationApprovalSettings,
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ApiError(
      "Publication approval settings must be an object",
      400,
      "INVALID_PUBLICATION_SETTINGS",
    );
  }
  return {
    ...previous,
    ...value,
    thresholds: {
      ...previous.thresholds,
      ...(isRecord(value.thresholds) ? value.thresholds : {}),
    },
  };
}

export function normalizePublicationApprovalSettings(
  value: unknown,
): PublicationApprovalSettings {
  const source = isRecord(value) ? value : {};
  const thresholds = isRecord(source.thresholds) ? source.thresholds : {};
  const defaults = DEFAULT_PUBLICATION_APPROVAL_SETTINGS;
  // Compatibility for local databases created by the first approval-policy
  // implementation. New writes only use the independently configurable
  // domain switches below.
  const legacyEnabled = booleanValue(source.enabled, true);
  const legacyConnectorReview = booleanValue(
    source.require_connector_onboarding_approval,
    true,
  );
  const legacyReviewerTeams = stringList(source.default_approver_team_slugs);
  const legacyReviewerUsers = stringList(source.default_approver_user_subjects);
  const reviewerTeams = (key: string): string[] =>
    Array.isArray(source[key]) ? stringList(source[key]) : legacyReviewerTeams;
  const reviewerUsers = (key: string): string[] =>
    Array.isArray(source[key]) ? stringList(source[key]) : legacyReviewerUsers;
  return {
    require_rag_publication_approval: booleanValue(
      source.require_rag_publication_approval,
      legacyEnabled && defaults.require_rag_publication_approval,
    ),
    require_slack_onboarding_approval: booleanValue(
      source.require_slack_onboarding_approval,
      legacyEnabled && legacyConnectorReview,
    ),
    require_webex_onboarding_approval: booleanValue(
      source.require_webex_onboarding_approval,
      legacyEnabled && legacyConnectorReview,
    ),
    allow_organization_wide_self_approval: booleanValue(
      source.allow_organization_wide_self_approval,
      defaults.allow_organization_wide_self_approval,
    ),
    trusted_publishers_bypass: booleanValue(
      source.trusted_publishers_bypass,
      defaults.trusted_publishers_bypass,
    ),
    trusted_publisher_subjects: stringList(source.trusted_publisher_subjects),
    trusted_publisher_team_slugs: stringList(source.trusted_publisher_team_slugs),
    organization_wide_team_slugs: Array.isArray(
      source.organization_wide_team_slugs,
    )
      ? stringList(source.organization_wide_team_slugs, { lowerCase: true })
      : defaults.organization_wide_team_slugs,
    rag_reviewer_team_slugs: reviewerTeams("rag_reviewer_team_slugs"),
    rag_reviewer_user_subjects: reviewerUsers("rag_reviewer_user_subjects"),
    slack_reviewer_team_slugs: reviewerTeams("slack_reviewer_team_slugs"),
    slack_reviewer_user_subjects: reviewerUsers("slack_reviewer_user_subjects"),
    webex_reviewer_team_slugs: reviewerTeams("webex_reviewer_team_slugs"),
    webex_reviewer_user_subjects: reviewerUsers("webex_reviewer_user_subjects"),
    rag_reviewer_team_delegations: normalizeDelegations(
      source.rag_reviewer_team_delegations ?? source.approver_team_delegations,
    ),
    rag_reviewer_user_delegations: normalizeDelegations(
      source.rag_reviewer_user_delegations ?? source.approver_user_delegations,
    ),
    thresholds: {
      slack_channel_members_without_approval: boundedInteger(
        thresholds.slack_channel_members_without_approval,
        defaults.thresholds.slack_channel_members_without_approval,
      ),
      webex_space_members_without_approval: boundedInteger(
        thresholds.webex_space_members_without_approval,
        defaults.thresholds.webex_space_members_without_approval,
      ),
    },
  };
}

export async function getPublicationApprovalSettings(): Promise<PublicationApprovalSettings> {
  const collection = await getCollection<PlatformConfigPublicationDocument>("platform_config");
  const doc = await collection.findOne({ _id: "platform_settings" } as never);
  return normalizePublicationApprovalSettings(doc?.publication_approval);
}

function allApproverTeams(settings: PublicationApprovalSettings): string[] {
  return Array.from(new Set([
    ...settings.rag_reviewer_team_slugs,
    ...settings.slack_reviewer_team_slugs,
    ...settings.webex_reviewer_team_slugs,
    ...Object.values(settings.rag_reviewer_team_delegations).flat(),
  ]));
}

function allApproverUsers(settings: PublicationApprovalSettings): string[] {
  return Array.from(new Set([
    ...settings.rag_reviewer_user_subjects,
    ...settings.slack_reviewer_user_subjects,
    ...settings.webex_reviewer_user_subjects,
    ...Object.values(settings.rag_reviewer_user_delegations).flat(),
  ]));
}

async function requireExistingPolicyTeams(
  settings: PublicationApprovalSettings,
): Promise<void> {
  const delegationTargets = Array.from(new Set([
    ...Object.keys(settings.rag_reviewer_team_delegations),
    ...Object.keys(settings.rag_reviewer_user_delegations),
  ])).filter((slug) => slug !== "*");
  const referenced = Array.from(new Set([
    ...allApproverTeams(settings),
    ...settings.trusted_publisher_team_slugs,
    ...settings.organization_wide_team_slugs,
    ...delegationTargets,
  ]));
  if (referenced.length === 0) return;
  const teams = await getCollection<{ slug: string }>("teams");
  const existing = await teams
    .find({ slug: { $in: referenced } } as never)
    .project({ _id: 0, slug: 1 })
    .toArray();
  const existingSlugs = new Set(existing.map((team) => team.slug));
  const missing = referenced.filter((slug) => !existingSlugs.has(slug));
  if (missing.length > 0) {
    throw new ApiError(
      `These publication policy teams do not exist: ${missing.join(", ")}`,
      400,
      "PUBLICATION_POLICY_TEAM_NOT_FOUND",
    );
  }
}

async function requireExistingPolicyUsers(
  settings: PublicationApprovalSettings,
): Promise<void> {
  const referenced = Array.from(new Set([
    ...allApproverUsers(settings),
    ...settings.trusted_publisher_subjects,
  ]));
  if (referenced.length === 0) return;
  const identities = await resolveUserIdentitiesBySubject(referenced);
  const missing = referenced.filter((subject) => !identities.has(subject));
  if (missing.length > 0) {
    throw new ApiError(
      "One or more selected publication-policy users no longer exists",
      400,
      "PUBLICATION_POLICY_USER_NOT_FOUND",
    );
  }
}

function approverTuple(teamSlug: string): OpenFgaTupleKey {
  return {
    user: `team:${teamSlug}#member`,
    relation: "approver",
    object: `policy:${PUBLICATION_POLICY_ID}`,
  };
}

function userApproverTuple(subject: string): OpenFgaTupleKey {
  return {
    user: `user:${subject}`,
    relation: "approver",
    object: `policy:${PUBLICATION_POLICY_ID}`,
  };
}

function legacyAdminOnlyApproverTuple(teamSlug: string): OpenFgaTupleKey {
  return {
    user: `team:${teamSlug}#admin`,
    relation: "approver",
    object: `policy:${PUBLICATION_POLICY_ID}`,
  };
}

export async function savePublicationApprovalSettings(
  nextValue: unknown,
  actor: { subject: string; email?: string | null },
): Promise<PublicationApprovalSettings> {
  const collection = await getCollection<PlatformConfigPublicationDocument>("platform_config");
  const previousDoc = await collection.findOne({ _id: "platform_settings" } as never);
  const previous = normalizePublicationApprovalSettings(previousDoc?.publication_approval);
  const next = normalizePublicationApprovalSettings(
    mergeSettingsUpdate(previous, nextValue),
  );
  await requireExistingPolicyTeams(next);
  await requireExistingPolicyUsers(next);
  const previousTeams = new Set(allApproverTeams(previous));
  const nextTeams = new Set(allApproverTeams(next));
  const previousUsers = new Set(allApproverUsers(previous));
  const nextUsers = new Set(allApproverUsers(next));
  await reconcileTupleDiff(
    {
      writes: [
        ...[...nextTeams].map(approverTuple),
        ...[...nextUsers].map(userApproverTuple),
      ],
      deletes: [
        ...[...previousTeams]
          .filter((slug) => !nextTeams.has(slug))
          .map(approverTuple),
        ...[...previousTeams].map(legacyAdminOnlyApproverTuple),
        ...[...previousUsers]
          .filter((subject) => !nextUsers.has(subject))
          .map(userApproverTuple),
      ],
    },
    {
      caller: { type: "user", id: actor.subject },
      source: "publication_approval_settings",
    },
  );
  try {
    await collection.updateOne(
      { _id: "platform_settings" } as never,
      {
        $set: {
          publication_approval: next,
          updated_at: new Date(),
          updated_by: actor.email ?? actor.subject,
        },
      } as never,
      { upsert: true },
    );
  } catch (error) {
    await reconcileTupleDiff(
      {
        writes: [
          ...[...previousTeams].map(approverTuple),
          ...[...previousUsers].map(userApproverTuple),
        ],
        deletes: [
          ...[...nextTeams]
            .filter((slug) => !previousTeams.has(slug))
            .map(approverTuple),
          ...[...nextUsers]
            .filter((subject) => !previousUsers.has(subject))
            .map(userApproverTuple),
        ],
      },
      { source: "publication_approval_settings_rollback" },
    ).catch(() => {});
    throw error;
  }
  return next;
}
