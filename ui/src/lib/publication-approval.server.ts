import { createHash, randomUUID } from "node:crypto";
import type { Collection } from "mongodb";

import { ApiError } from "@/lib/api-error";
import { reconcileTupleDiff } from "@/lib/authz";
import {
  archiveInAppNotifications,
  createInAppNotification,
} from "@/lib/in-app-notifications.server";
import { getCollection } from "@/lib/mongodb";
import {
  getPublicationApprovalSettings,
} from "@/lib/publication-approval-settings";
import {
  checkOpenFgaTuple,
  listOpenFgaObjects,
  type OpenFgaTupleKey,
} from "@/lib/rbac/openfga";
import { organizationObjectId } from "@/lib/rbac/organization";
import type {
  PublicationActor,
  PublicationApprovalSettings,
  PublicationAuditAction,
  PublicationPolicyPlan,
  PendingConnectorPublicationRequestView,
  PublicationRequestDocument,
  PublicationRequestPage,
  PublicationRequestSummary,
  PublicationRequestStatus,
  PublicationResourceKind,
  PublicationResourceRef,
} from "@/types/publication-approval";

const REQUEST_COLLECTION = "publication_requests";
const ACTIVE_STATUSES: PublicationRequestStatus[] = ["pending", "applying"];
const APPLY_LEASE_MS = 5 * 60 * 1000;

function publicationNotificationKey(
  requestId: string,
  event: "requested" | "approved" | "rejected",
): string {
  return `publication:${requestId}:${event}`;
}

function actorDisplayName(actor: PublicationActor): string {
  return actor.name || actor.email || "A user";
}

async function notifyPublicationRequestCreated(
  request: PublicationRequestDocument,
): Promise<void> {
  try {
    await createInAppNotification({
      eventKey: publicationNotificationKey(request._id, "requested"),
      recipientUserSubjects: request.approver_user_subjects,
      recipientTeamSlugs: request.approver_team_slugs,
      recipientOrganizationAdmins: true,
      title: "Approval needed",
      message: `${actorDisplayName(request.requester)} submitted a publication request.`,
      href: `/admin/security/approvals?request=${encodeURIComponent(request._id)}`,
      severity: "warning",
    });
  } catch (error) {
    console.error("[publication-approval] could not create reviewer notification", error);
  }
}

async function notifyPublicationRequestDecision(
  request: PublicationRequestDocument,
  decision: "approved" | "rejected",
  actor: PublicationActor,
): Promise<void> {
  try {
    await archiveInAppNotifications([
      publicationNotificationKey(request._id, "requested"),
    ]);
    await createInAppNotification({
      eventKey: publicationNotificationKey(request._id, decision),
      recipientUserSubjects: [request.requester.subject],
      title: decision === "approved" ? "Request approved" : "Request rejected",
      message: decision === "rejected" && request.decision_note?.trim()
        ? `${request.resource.label} was rejected by ${actorDisplayName(actor)}. Reason: ${request.decision_note.trim()}`
        : `${request.resource.label} was ${decision} by ${actorDisplayName(actor)}.`,
      href: `/admin/security/approvals?view=history&request=${encodeURIComponent(request._id)}`,
      severity: decision === "approved" ? "success" : "error",
    });
  } catch (error) {
    console.error("[publication-approval] could not create decision notification", error);
  }
}

async function archivePublicationRequestNotification(requestId: string): Promise<void> {
  try {
    await archiveInAppNotifications([
      publicationNotificationKey(requestId, "requested"),
    ]);
  } catch (error) {
    console.error("[publication-approval] could not archive reviewer notification", error);
  }
}

export interface PublicationSession {
  sub?: unknown;
  role?: string;
  accessToken?: string;
  org?: string;
  user?: { email?: string | null; name?: string | null } | null;
}

export interface RagPublicationState {
  search_team_slugs: string[];
  search_user_subjects: string[];
  source_update?: Record<string, unknown>;
  owner_update?: {
    owner_team_slug: string | null;
    owner_subject: string | null;
  };
}

export interface RagCollectionPublicationState {
  maintainer_team_slugs: string[];
  reader_team_slugs: string[];
  global_read: boolean;
  source_ids: string[];
}

interface RagPublicationPlanInput {
  settings: PublicationApprovalSettings;
  requester: PublicationActor;
  requesterTeamSlugs: string[];
  currentState: RagPublicationState;
  requestedState: RagPublicationState;
  ownerTeamSlug?: string | null;
  ownerSubject?: string | null;
  sourceType?: string;
  sourceDomain?: string | null;
  estimatedItems?: number;
  materialChange?: boolean;
  externalAudienceTeamSlugs?: string[];
  externalBroadAudience?: boolean;
  externalOrganizationWide?: boolean;
}

interface ConnectorPublicationPlanInput {
  settings: PublicationApprovalSettings;
  requester: PublicationActor;
  requesterTeamSlugs: string[];
  resourceKind: "slack_channel" | "webex_space";
  requestedState: Record<string, unknown>;
  targetTeamSlug: string;
  memberCount?: number;
}

interface RagCollectionPublicationPlanInput {
  settings: PublicationApprovalSettings;
  requester: PublicationActor;
  requesterTeamSlugs: string[];
  currentState: RagCollectionPublicationState;
  requestedState: RagCollectionPublicationState;
}

export interface CreatePublicationRequestInput {
  resource: PublicationResourceRef;
  resourceRevision: string;
  requestedState: Record<string, unknown>;
  effectiveState: Record<string, unknown>;
  riskFacts: PublicationRequestDocument["risk_facts"];
  requester: PublicationActor;
  requesterTeamSlugs: string[];
  approverTeamSlugs: string[];
  approverUserSubjects?: string[];
}

export interface PublicationRequestListOptions {
  statuses?: PublicationRequestStatus[];
  kinds?: PublicationResourceKind[];
  resourceIds?: string[];
  requestIds?: string[];
  mine?: boolean;
}

export interface PublicationRequestPageOptions extends PublicationRequestListOptions {
  page?: number;
  pageSize?: number;
}

function normalizedStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values.flatMap((value) =>
        typeof value === "string" && value.trim() ? [value.trim()] : [],
      ),
    ),
  ).sort();
}

function asRagState(value: Record<string, unknown>): RagPublicationState {
  const rawOwnerUpdate = value.owner_update;
  const ownerUpdate = rawOwnerUpdate &&
    typeof rawOwnerUpdate === "object" &&
    !Array.isArray(rawOwnerUpdate)
    ? rawOwnerUpdate as Record<string, unknown>
    : null;
  return {
    search_team_slugs: normalizedStrings(value.search_team_slugs),
    search_user_subjects: normalizedStrings(value.search_user_subjects),
    ...(value.source_update &&
    typeof value.source_update === "object" &&
    !Array.isArray(value.source_update)
      ? { source_update: value.source_update as Record<string, unknown> }
      : {}),
    ...(ownerUpdate
      ? {
          owner_update: {
            owner_team_slug:
              typeof ownerUpdate.owner_team_slug === "string"
                ? ownerUpdate.owner_team_slug.trim() || null
                : null,
            owner_subject:
              typeof ownerUpdate.owner_subject === "string"
                ? ownerUpdate.owner_subject.trim() || null
                : null,
          },
        }
      : {}),
  };
}

function intersection(values: string[], allowed: Set<string>): string[] {
  return values.filter((value) => allowed.has(value));
}

function difference(values: string[], previous: Set<string>): string[] {
  return values.filter((value) => !previous.has(value));
}

function isOrganizationWideTeam(
  slug: string,
  settings: PublicationApprovalSettings,
): boolean {
  const normalized = slug.trim().toLowerCase();
  return settings.organization_wide_team_slugs.some(
    (candidate) => candidate.trim().toLowerCase() === normalized,
  );
}

function isTrustedPublisher(
  requester: PublicationActor,
  requesterTeamSlugs: string[],
  settings: PublicationApprovalSettings,
): boolean {
  if (!settings.trusted_publishers_bypass) return false;
  if (settings.trusted_publisher_subjects.includes(requester.subject)) return true;
  const requesterTeams = new Set(requesterTeamSlugs);
  return settings.trusted_publisher_team_slugs.some((slug) => requesterTeams.has(slug));
}

export function reviewerAssignmentsForResource(
  resourceKind: PublicationResourceKind,
  targetTeamSlugs: string[],
  settings: PublicationApprovalSettings,
): { teams: string[]; users: string[] } {
  if (resourceKind === "slack_channel") {
    return {
      teams: [...new Set(settings.slack_reviewer_team_slugs)].sort(),
      users: [...new Set(settings.slack_reviewer_user_subjects)].sort(),
    };
  }
  if (resourceKind === "webex_space") {
    return {
      teams: [...new Set(settings.webex_reviewer_team_slugs)].sort(),
      users: [...new Set(settings.webex_reviewer_user_subjects)].sort(),
    };
  }

  const teams = new Set(settings.rag_reviewer_team_slugs);
  const users = new Set(settings.rag_reviewer_user_subjects);
  for (const target of ["*", ...targetTeamSlugs]) {
    for (const reviewer of settings.rag_reviewer_team_delegations[target] ?? []) {
      teams.add(reviewer);
    }
    for (const reviewer of settings.rag_reviewer_user_delegations[target] ?? []) {
      users.add(reviewer);
    }
  }
  return { teams: [...teams].sort(), users: [...users].sort() };
}

/**
 * Plan RAG publication without mutating state.
 *
 * Ordinary revocations are immediate. Removing a company-wide audience is
 * reviewed, and that grant remains effective until the change is approved. A
 * personal owner, or an explicitly selected management-owner team, can receive
 * Search immediately. New audiences outside that owner scope remain requested
 * until an approver publishes them.
 */
export function planRagPublication(input: RagPublicationPlanInput): PublicationPolicyPlan {
  const current = asRagState(input.currentState as unknown as Record<string, unknown>);
  const requested = asRagState(input.requestedState as unknown as Record<string, unknown>);
  const currentTeams = new Set(current.search_team_slugs);
  const currentUsers = new Set(current.search_user_subjects);
  const requestedTeams = new Set(requested.search_team_slugs);
  const requestedUsers = new Set(requested.search_user_subjects);
  const addedTeams = difference(requested.search_team_slugs, currentTeams);
  const addedUsers = difference(requested.search_user_subjects, currentUsers);
  const removedTeams = difference(current.search_team_slugs, requestedTeams);
  const removedOrganizationWideTeams = removedTeams.filter((slug) =>
    isOrganizationWideTeam(slug, input.settings),
  );
  const ownerScopedTeams = new Set(
    input.ownerTeamSlug &&
    requestedTeams.has(input.ownerTeamSlug) &&
    !isOrganizationWideTeam(input.ownerTeamSlug, input.settings)
      ? [input.ownerTeamSlug]
      : [],
  );
  const ownerScopedUsers = new Set(
    input.ownerSubject && requestedUsers.has(input.ownerSubject)
      ? [input.ownerSubject]
      : [],
  );
  const pendingTeams = addedTeams.filter((slug) => !ownerScopedTeams.has(slug));
  const pendingUsers = addedUsers.filter((subject) => !ownerScopedUsers.has(subject));
  const externalReaderTeamSlugs = normalizedStrings(
    input.externalAudienceTeamSlugs ?? [],
  );
  const externalAudienceTeamSlugs = externalReaderTeamSlugs.filter(
    (slug) =>
      slug !== input.ownerTeamSlug || isOrganizationWideTeam(slug, input.settings),
  );
  const organizationWide = removedOrganizationWideTeams.length > 0 ||
    Boolean(input.externalOrganizationWide) ||
    requested.search_team_slugs.some((slug) =>
      isOrganizationWideTeam(slug, input.settings),
    ) || externalAudienceTeamSlugs.some((slug) =>
      isOrganizationWideTeam(slug, input.settings),
    );
  // Organization-wide Search always counts as broad publication, even when
  // the same team is also the management owner. Owner and Search are
  // independent grants; making Everyone the owner must not become an approval
  // bypass for publishing content to Everyone.
  const newOrganizationWideAudience = addedTeams.some((slug) =>
    isOrganizationWideTeam(slug, input.settings),
  );
  const hasBroadAudience = removedOrganizationWideTeams.length > 0 ||
    Boolean(input.externalBroadAudience) ||
    externalAudienceTeamSlugs.length > 0 ||
    Boolean(input.externalOrganizationWide) || requested.search_team_slugs.some(
    (slug) =>
      slug !== input.ownerTeamSlug || isOrganizationWideTeam(slug, input.settings),
  ) || requested.search_user_subjects.some((subject) => subject !== input.ownerSubject);
  const trusted = isTrustedPublisher(
    input.requester,
    input.requesterTeamSlugs,
    input.settings,
  );
  const materialBroadChange = Boolean(input.materialChange && hasBroadAudience);
  const requiresApproval =
    input.settings.require_rag_publication_approval &&
    !trusted &&
    (
      newOrganizationWideAudience ||
      removedOrganizationWideTeams.length > 0 ||
      pendingTeams.length > 0 ||
      pendingUsers.length > 0 ||
      materialBroadChange
    );

  const reasons: string[] = [];
  if (newOrganizationWideAudience) reasons.push("new organization-wide audience");
  if (removedOrganizationWideTeams.length > 0) {
    reasons.push("organization-wide audience removal");
  }
  if (pendingTeams.length > 0) reasons.push(`${pendingTeams.length} new team audience${pendingTeams.length === 1 ? "" : "s"}`);
  if (pendingUsers.length > 0) reasons.push(`${pendingUsers.length} new person audience${pendingUsers.length === 1 ? "" : "s"}`);
  if (materialBroadChange) reasons.push("material source change with a broad audience");
  if (materialBroadChange && externalAudienceTeamSlugs.length > 0) {
    reasons.push("source is published through a collection");
  }
  if (trusted) reasons.push("trusted publisher");

  const retainedTeams = intersection(requested.search_team_slugs, currentTeams);
  const retainedUsers = intersection(requested.search_user_subjects, currentUsers);
  const effectiveState: RagPublicationState = requiresApproval
    ? {
        search_team_slugs: Array.from(new Set([
          ...retainedTeams,
          ...ownerScopedTeams,
          ...removedOrganizationWideTeams,
        ])).sort(),
        search_user_subjects: Array.from(new Set([...retainedUsers, ...ownerScopedUsers])).sort(),
      }
    : requested;

  const targetTeamSlugs = Array.from(new Set([
    ...pendingTeams,
    ...removedOrganizationWideTeams,
    ...(materialBroadChange ? externalAudienceTeamSlugs : []),
    ...(materialBroadChange && input.externalOrganizationWide
      ? input.settings.organization_wide_team_slugs
      : []),
  ])).sort();
  const reviewers = reviewerAssignmentsForResource(
    "rag_datasource",
    targetTeamSlugs,
    input.settings,
  );
  return {
    requires_approval: requiresApproval,
    reason: requiresApproval
      ? `Approval required: ${reasons.join(", ") || "publication policy"}.`
      : trusted
        ? "Published immediately by trusted-publisher policy."
        : "Published immediately within the configured policy.",
    effective_state: effectiveState as unknown as Record<string, unknown>,
    risk_facts: {
      organization_wide: organizationWide,
      target_team_slugs: targetTeamSlugs,
      added_team_slugs: addedTeams,
      removed_team_slugs: removedOrganizationWideTeams,
      added_user_subjects: addedUsers,
      ...(input.sourceType ? { source_type: input.sourceType } : {}),
      ...(input.sourceDomain ? { source_domain: input.sourceDomain } : {}),
      ...(typeof input.estimatedItems === "number"
        ? { estimated_items: input.estimatedItems }
        : {}),
      material_change: Boolean(input.materialChange),
      trusted_policy_bypass: trusted,
      reasons,
    },
    approver_team_slugs: reviewers.teams,
    approver_user_subjects: reviewers.users,
    requester_team_slugs: [...new Set(input.requesterTeamSlugs)].sort(),
  };
}

function asRagCollectionState(value: RagCollectionPublicationState): RagCollectionPublicationState {
  return {
    maintainer_team_slugs: normalizedStrings(value.maintainer_team_slugs),
    reader_team_slugs: normalizedStrings(value.reader_team_slugs),
    global_read: value.global_read === true,
    source_ids: normalizedStrings(value.source_ids),
  };
}

/**
 * Plan collection publication independently from collection management.
 *
 * Company-wide Search removals remain effective until approved. Removing a
 * datasource from a company-wide collection follows the same rule.
 */
export function planRagCollectionPublication(
  input: RagCollectionPublicationPlanInput,
): PublicationPolicyPlan {
  const current = asRagCollectionState(input.currentState);
  const requested = asRagCollectionState(input.requestedState);
  const currentReaders = new Set(current.reader_team_slugs);
  const currentSources = new Set(current.source_ids);
  const currentOwnerTeams = new Set(current.maintainer_team_slugs);
  const requestedOwnerTeams = new Set(requested.maintainer_team_slugs);
  const ownershipChange =
    publicationResourceRevision(current.maintainer_team_slugs) !==
    publicationResourceRevision(requested.maintainer_team_slugs);
  const addedReaders = difference(requested.reader_team_slugs, currentReaders);
  const removedReaders = difference(current.reader_team_slugs, new Set(requested.reader_team_slugs));
  const removedOrganizationWideReaders = removedReaders.filter((slug) =>
    isOrganizationWideTeam(slug, input.settings),
  );
  const pendingReaders = addedReaders.filter(
    (slug) => !requestedOwnerTeams.has(slug),
  );
  const addedSources = difference(requested.source_ids, currentSources);
  const removedSources = difference(current.source_ids, new Set(requested.source_ids));
  const newGlobalRead = requested.global_read && !current.global_read;
  const removedGlobalRead = current.global_read && !requested.global_read;
  const currentOrganizationWide = current.global_read || current.reader_team_slugs.some(
    (slug) => isOrganizationWideTeam(slug, input.settings),
  );
  const removedOrganizationWideAudience = removedGlobalRead ||
    removedOrganizationWideReaders.length > 0;
  const organizationWide = currentOrganizationWide || requested.global_read || requested.reader_team_slugs.some(
    (slug) => isOrganizationWideTeam(slug, input.settings),
  );
  const newOrganizationWideAudience = newGlobalRead || addedReaders.some(
    (slug) => isOrganizationWideTeam(slug, input.settings),
  );
  const hasBroadAudience = requested.global_read || requested.reader_team_slugs.some(
    (slug) =>
      !currentOwnerTeams.has(slug) ||
      !requestedOwnerTeams.has(slug) ||
      isOrganizationWideTeam(slug, input.settings),
  );
  const sourceAdditionPublicationChange = addedSources.length > 0 &&
    (hasBroadAudience || removedOrganizationWideAudience);
  const sourceRemovalPublicationChange = removedSources.length > 0 &&
    currentOrganizationWide;
  const sourcePublicationChange = sourceAdditionPublicationChange ||
    sourceRemovalPublicationChange;
  const ownershipPublicationChange = ownershipChange &&
    (hasBroadAudience || removedOrganizationWideAudience);
  const trusted = isTrustedPublisher(
    input.requester,
    input.requesterTeamSlugs,
    input.settings,
  );
  const requiresApproval =
    input.settings.require_rag_publication_approval &&
    !trusted &&
    (
      newOrganizationWideAudience ||
      removedOrganizationWideAudience ||
      pendingReaders.length > 0 ||
      sourcePublicationChange ||
      ownershipPublicationChange
    );

  const retainedReaders = intersection(requested.reader_team_slugs, currentReaders);
  const ownerScopedReaders = addedReaders.filter(
    (slug) => currentOwnerTeams.has(slug) && !isOrganizationWideTeam(slug, input.settings),
  );
  const effectiveSourceIds = sourceAdditionPublicationChange
    ? intersection(requested.source_ids, currentSources)
    : [...requested.source_ids];
  if (sourceRemovalPublicationChange) {
    effectiveSourceIds.push(...removedSources);
  }
  const effectiveState: RagCollectionPublicationState = requiresApproval
    ? {
        maintainer_team_slugs: current.maintainer_team_slugs,
        reader_team_slugs: Array.from(
          new Set([
            ...retainedReaders,
            ...ownerScopedReaders,
            ...removedOrganizationWideReaders,
          ]),
        ).sort(),
        global_read: current.global_read,
        source_ids: [...new Set(effectiveSourceIds)].sort(),
      }
    : requested;

  const reasons: string[] = [];
  if (newOrganizationWideAudience) reasons.push("new organization-wide audience");
  if (removedOrganizationWideAudience) {
    reasons.push("organization-wide audience removal");
  }
  if (pendingReaders.length > 0) {
    reasons.push(
      `${pendingReaders.length} new team audience${pendingReaders.length === 1 ? "" : "s"}`,
    );
  }
  if (sourceAdditionPublicationChange) {
    reasons.push(
      `${addedSources.length} datasource${addedSources.length === 1 ? "" : "s"} added to a shared collection`,
    );
  }
  if (sourceRemovalPublicationChange) {
    reasons.push(
      `${removedSources.length} datasource${removedSources.length === 1 ? "" : "s"} removed from a company-wide collection`,
    );
  }
  if (ownershipPublicationChange) {
    reasons.push("collection ownership changed while Search is broadly shared");
  }
  if (trusted) reasons.push("trusted publisher");

  const targetTeamSlugs = Array.from(new Set([
    ...pendingReaders,
    ...removedOrganizationWideReaders,
    ...addedReaders.filter((slug) => isOrganizationWideTeam(slug, input.settings)),
    ...(newGlobalRead ? input.settings.organization_wide_team_slugs : []),
    ...(removedGlobalRead ? input.settings.organization_wide_team_slugs : []),
  ])).sort();
  const reviewers = reviewerAssignmentsForResource(
    "rag_collection",
    targetTeamSlugs,
    input.settings,
  );
  return {
    requires_approval: requiresApproval,
    reason: requiresApproval
      ? `Approval required: ${reasons.join(", ") || "collection publication policy"}.`
      : trusted
        ? "Published immediately by trusted-publisher policy."
        : "Published immediately within the configured policy.",
    effective_state: effectiveState as unknown as Record<string, unknown>,
    risk_facts: {
      organization_wide: organizationWide,
      target_team_slugs: targetTeamSlugs,
      added_team_slugs: addedReaders,
      removed_team_slugs: Array.from(new Set([
        ...removedOrganizationWideReaders,
        ...(removedGlobalRead ? input.settings.organization_wide_team_slugs : []),
      ])).sort(),
      added_user_subjects: [],
      added_source_ids: addedSources,
      removed_source_ids: sourceRemovalPublicationChange ? removedSources : [],
      previous_owner_team_slugs: current.maintainer_team_slugs,
      requested_owner_team_slugs: requested.maintainer_team_slugs,
      material_change: sourcePublicationChange || ownershipPublicationChange,
      trusted_policy_bypass: trusted,
      reasons,
    },
    approver_team_slugs: reviewers.teams,
    approver_user_subjects: reviewers.users,
    requester_team_slugs: [...new Set(input.requesterTeamSlugs)].sort(),
  };
}

/** Plan self-service Slack/Webex onboarding as publication of a chat surface. */
export function planConnectorPublication(
  input: ConnectorPublicationPlanInput,
): PublicationPolicyPlan {
  const threshold = input.resourceKind === "slack_channel"
    ? input.settings.thresholds.slack_channel_members_without_approval
    : input.settings.thresholds.webex_space_members_without_approval;
  const memberCountKnown = typeof input.memberCount === "number";
  const thresholdExceeded = !memberCountKnown || input.memberCount! > threshold;
  const reviewEnabled = input.resourceKind === "slack_channel"
    ? input.settings.require_slack_onboarding_approval
    : input.settings.require_webex_onboarding_approval;
  const requiresApproval = reviewEnabled && thresholdExceeded;
  const reasons = [
    ...(!memberCountKnown
      ? ["audience size is unknown"]
      : thresholdExceeded
        ? [`${input.memberCount} channel or space members`]
        : []),
  ];
  const reviewers = reviewerAssignmentsForResource(
    input.resourceKind,
    [input.targetTeamSlug],
    input.settings,
  );
  return {
    requires_approval: requiresApproval,
    reason: requiresApproval
      ? `Approval required: ${reasons.join(", ") || "connector onboarding policy"}.`
      : "Onboarded immediately within the configured policy.",
    effective_state: requiresApproval ? {} : input.requestedState,
    risk_facts: {
      organization_wide: false,
      target_team_slugs: [input.targetTeamSlug],
      ...(typeof input.memberCount === "number"
        ? { member_count: input.memberCount }
        : {}),
      reasons,
    },
    approver_team_slugs: reviewers.teams,
    approver_user_subjects: reviewers.users,
    requester_team_slugs: [...new Set(input.requesterTeamSlugs)].sort(),
  };
}

// Drop undefined-valued keys before they ever reach Mongo. The driver's BSON
// serializer converts an undefined-valued key to a stored `null` on insert,
// but JSON.stringify (used by publicationResourceRevision) drops it entirely.
// Without this filter, the revision hashed before storage never matches the
// hash recomputed from the round-tripped document, so every approval trips
// a false "changed after approval was requested" conflict.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function publicationAuthorizationPolicyId(
  resource: PublicationResourceRef,
  requestId: string,
): string {
  const resourceHash = createHash("sha256").update(resource.id).digest("hex").slice(0, 24);
  return `publication.${resource.kind}.${resourceHash}.${requestId}`;
}

function requestApproverTuple(
  request: PublicationRequestDocument,
  actor: PublicationActor,
): OpenFgaTupleKey {
  return {
    user: `user:${actor.subject}`,
    relation: "approver",
    object: `policy:${request.authorization_policy_id}`,
  };
}

async function grantRequestApplyCapability(
  request: PublicationRequestDocument,
  actor: PublicationActor,
): Promise<void> {
  await reconcileTupleDiff(
    { writes: [requestApproverTuple(request, actor)], deletes: [] },
    {
      caller: { type: "user", id: actor.subject },
      source: "publication_request_apply",
    },
  );
}

async function revokeRequestApplyCapability(
  request: PublicationRequestDocument,
  actor: PublicationActor,
): Promise<void> {
  await reconcileTupleDiff(
    { writes: [], deletes: [requestApproverTuple(request, actor)] },
    {
      caller: { type: "user", id: actor.subject },
      source: "publication_request_apply_cleanup",
    },
  );
}

/** Stable optimistic-concurrency revision for adapter-owned resource state. */
export function publicationResourceRevision(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function publicationActorFromSession(session: PublicationSession): PublicationActor {
  const subject = typeof session.sub === "string" ? session.sub.trim() : "";
  if (!subject) {
    throw new ApiError("Your session has expired. Please sign in again.", 401, "NO_TOKEN");
  }
  return {
    subject,
    email: session.user?.email?.trim() || null,
    name: session.user?.name?.trim() || null,
  };
}

function teamSlugFromObject(value: string): string | null {
  const match = /^team:(.+)$/.exec(value);
  return match?.[1]?.trim() || null;
}

export async function listPublicationActorTeamSlugs(
  actor: PublicationActor,
  relation: "member" | "admin" = "member",
): Promise<string[]> {
  const result = await listOpenFgaObjects({
    user: `user:${actor.subject}`,
    relation,
    type: "team",
  });
  return Array.from(
    new Set(result.objects.map(teamSlugFromObject).filter((value): value is string => Boolean(value))),
  ).sort();
}

export async function canManagePublicationSettings(actor: PublicationActor): Promise<boolean> {
  try {
    return (
      await checkOpenFgaTuple({
        user: `user:${actor.subject}`,
        relation: "can_manage",
        object: organizationObjectId(),
      })
    ).allowed;
  } catch {
    return false;
  }
}

async function hasGlobalPublicationApproval(actor: PublicationActor): Promise<boolean> {
  try {
    return (
      await checkOpenFgaTuple({
        user: `user:${actor.subject}`,
        relation: "can_approve",
        object: "policy:publication",
      })
    ).allowed;
  } catch {
    return false;
  }
}

export async function canApprovePublicationRequest(
  actor: PublicationActor,
  request: PublicationRequestDocument,
): Promise<boolean> {
  if (await canManagePublicationSettings(actor)) return true;
  if (!(await hasGlobalPublicationApproval(actor))) return false;
  const settings = await getPublicationApprovalSettings();
  const reviewers = reviewerAssignmentsForResource(
    request.resource.kind,
    request.risk_facts.target_team_slugs,
    settings,
  );
  if (reviewers.users.includes(actor.subject)) return true;
  const memberships = new Set(await listPublicationActorTeamSlugs(actor, "member"));
  return reviewers.teams.some((slug) => memberships.has(slug));
}

function auditEntry(
  action: PublicationAuditAction,
  actor: PublicationActor,
  at: string,
  values: Partial<PublicationRequestDocument["history"][number]> = {},
): PublicationRequestDocument["history"][number] {
  return { action, actor, at, ...values };
}

async function supersedePendingPublicationRequests(input: {
  collection: Collection<PublicationRequestDocument>;
  resource: PublicationResourceRef;
  replacementId: string;
  actor: PublicationActor;
  at: string;
}): Promise<void> {
  await input.collection.updateMany(
    {
      "resource.kind": input.resource.kind,
      "resource.id": input.resource.id,
      status: "pending",
      _id: { $ne: input.replacementId },
    } as never,
    {
      $set: { status: "superseded", updated_at: input.at, decided_at: input.at },
      $push: {
        history: auditEntry("superseded", input.actor, input.at, {
          note: `Replaced by publication decision ${input.replacementId}.`,
          from_status: "pending",
          to_status: "superseded",
        }),
      },
    } as never,
  );
  const replaced = await input.collection
    .find({
      "resource.kind": input.resource.kind,
      "resource.id": input.resource.id,
      status: "superseded",
      decided_at: input.at,
      _id: { $ne: input.replacementId },
    } as never)
    .toArray();
  await Promise.all(replaced.map((request) =>
    archivePublicationRequestNotification(request._id)
  ));
}

/**
 * Leave one deterministic pending proposal for a resource.
 *
 * Request creation can race across UI replicas. Selecting the first persisted
 * proposal (with `_id` as a stable same-millisecond tie-breaker) preserves
 * first-writer ownership so a simultaneous request cannot replace it.
 */
async function coalescePendingPublicationRequests(input: {
  collection: Collection<PublicationRequestDocument>;
  resource: PublicationResourceRef;
}): Promise<PublicationRequestDocument | null> {
  const pending = await input.collection
    .find({
      "resource.kind": input.resource.kind,
      "resource.id": input.resource.id,
      status: "pending",
    } as never)
    .sort({ created_at: 1, _id: 1 })
    .limit(1)
    .toArray();
  const winner = pending[0];
  if (!winner) return null;
  const now = new Date().toISOString();
  await supersedePendingPublicationRequests({
    collection: input.collection,
    resource: input.resource,
    replacementId: winner._id,
    actor: winner.requester,
    at: now,
  });
  return winner;
}

export async function createPublicationRequest(
  input: CreatePublicationRequestInput,
): Promise<PublicationRequestDocument> {
  const collection = await getCollection<PublicationRequestDocument>(REQUEST_COLLECTION);
  const now = new Date().toISOString();
  const id = randomUUID();
  const document: PublicationRequestDocument = {
    _id: id,
    adapter_version: 1,
    resource: input.resource,
    authorization_policy_id: publicationAuthorizationPolicyId(input.resource, id),
    resource_revision: input.resourceRevision,
    requested_state: canonicalize(input.requestedState) as Record<string, unknown>,
    effective_state: canonicalize(input.effectiveState) as Record<string, unknown>,
    risk_facts: input.riskFacts,
    requester: input.requester,
    requester_team_slugs: [...new Set(input.requesterTeamSlugs)].sort(),
    approver_team_slugs: [...new Set(input.approverTeamSlugs)].sort(),
    approver_user_subjects: [...new Set(input.approverUserSubjects ?? [])].sort(),
    status: "pending",
    history: [auditEntry("requested", input.requester, now, { to_status: "pending" })],
    created_at: now,
    updated_at: now,
  };
  await collection.insertOne(document as never);
  const winner = await coalescePendingPublicationRequests({
    collection,
    resource: input.resource,
  });
  if (!winner || winner._id === id) {
    await notifyPublicationRequestCreated(document);
    return document;
  }
  const supersededAt = new Date().toISOString();
  return {
    ...document,
    status: "superseded",
    updated_at: supersededAt,
    decided_at: supersededAt,
    history: [
      ...document.history,
      auditEntry("superseded", winner.requester, supersededAt, {
        note: `Replaced by publication decision ${winner._id}.`,
        from_status: "pending",
        to_status: "superseded",
      }),
    ],
  };
}

export async function recordAutoApprovedPublication(
  input: CreatePublicationRequestInput,
): Promise<PublicationRequestDocument> {
  const collection = await getCollection<PublicationRequestDocument>(REQUEST_COLLECTION);
  const now = new Date().toISOString();
  const id = randomUUID();
  const document: PublicationRequestDocument = {
    _id: id,
    adapter_version: 1,
    resource: input.resource,
    authorization_policy_id: publicationAuthorizationPolicyId(input.resource, id),
    resource_revision: input.resourceRevision,
    requested_state: canonicalize(input.requestedState) as Record<string, unknown>,
    effective_state: canonicalize(input.requestedState) as Record<string, unknown>,
    risk_facts: input.riskFacts,
    requester: input.requester,
    requester_team_slugs: [...new Set(input.requesterTeamSlugs)].sort(),
    approver_team_slugs: [...new Set(input.approverTeamSlugs)].sort(),
    approver_user_subjects: [...new Set(input.approverUserSubjects ?? [])].sort(),
    status: "approved",
    history: [auditEntry("auto_approved", input.requester, now, { to_status: "approved" })],
    created_at: now,
    updated_at: now,
    decided_at: now,
    decided_by: input.requester,
  };
  await collection.insertOne(document as never);
  // An immediate decision (including cancelling a previously requested
  // audience by saving the effective state) must make older proposals
  // unapprovable. Do not silently tolerate this update failing.
  await supersedePendingPublicationRequests({
    collection,
    resource: input.resource,
    replacementId: id,
    actor: input.requester,
    at: now,
  });
  return document;
}

export async function invalidatePublicationRequests(
  resource: PublicationResourceRef,
  actor: PublicationActor,
  note = "The resource changed after this request was created.",
): Promise<number> {
  const collection = await getCollection<PublicationRequestDocument>(REQUEST_COLLECTION);
  const now = new Date().toISOString();
  const result = await collection.updateMany(
    {
      "resource.kind": resource.kind,
      "resource.id": resource.id,
      status: "pending",
    } as never,
    {
      $set: { status: "superseded", updated_at: now, decided_at: now },
      $push: {
        history: auditEntry("superseded", actor, now, {
          note,
          from_status: "pending",
          to_status: "superseded",
        }),
      },
    } as never,
  );
  const applying = await collection.findOne({
    "resource.kind": resource.kind,
    "resource.id": resource.id,
    status: "applying",
  } as never);
  const invalidated = await collection.find({
    "resource.kind": resource.kind,
    "resource.id": resource.id,
    status: "superseded",
    decided_at: now,
  } as never).toArray();
  await Promise.all(invalidated.map((request) =>
    archivePublicationRequestNotification(request._id)
  ));
  if (applying) {
    throw new ApiError(
      "An approval is being applied to this resource. Try again in a moment.",
      409,
      "PUBLICATION_APPLY_IN_PROGRESS",
    );
  }
  return result.modifiedCount;
}

/**
 * Replace a connector-onboarding proposal without letting one requester
 * overwrite another person's pending request.
 */
export async function replacePendingConnectorPublicationRequest(
  resource: PublicationResourceRef,
  actor: PublicationActor,
  note: string,
): Promise<number> {
  if (resource.kind !== "slack_channel" && resource.kind !== "webex_space") {
    throw new ApiError("Connector request replacement requires a chat resource", 400);
  }
  const collection = await getCollection<PublicationRequestDocument>(REQUEST_COLLECTION);
  const applying = await collection.findOne({
    "resource.kind": resource.kind,
    "resource.id": resource.id,
    status: "applying",
  } as never);
  if (applying) {
    throw new ApiError(
      "This request is already being approved. Try again in a moment.",
      409,
      "PUBLICATION_APPLY_IN_PROGRESS",
    );
  }
  const pending = await collection
    .find({
      "resource.kind": resource.kind,
      "resource.id": resource.id,
      status: "pending",
    } as never)
    .sort({ created_at: -1, _id: -1 })
    .toArray();
  const owned = pending.filter((request) => request.requester.subject === actor.subject);
  const someoneElses = pending.find(
    (request) => request.requester.subject !== actor.subject,
  );
  if (someoneElses) {
    throw new ApiError(
      `${resource.label} already has a request from ${actorDisplayName(someoneElses.requester)}.`,
      409,
      "PUBLICATION_REQUEST_OWNED_BY_ANOTHER_USER",
    );
  }
  if (owned.length === 0) return 0;
  const now = new Date().toISOString();
  const result = await collection.updateMany(
    {
      "resource.kind": resource.kind,
      "resource.id": resource.id,
      "requester.subject": actor.subject,
      status: "pending",
    } as never,
    {
      $set: { status: "superseded", updated_at: now, decided_at: now },
      $push: {
        history: auditEntry("superseded", actor, now, {
          note,
          from_status: "pending",
          to_status: "superseded",
        }),
      },
    } as never,
  );
  const applyingAfterUpdate = await collection.findOne({
    "resource.kind": resource.kind,
    "resource.id": resource.id,
    status: "applying",
  } as never);
  const replaced = await collection.find({
    "resource.kind": resource.kind,
    "resource.id": resource.id,
    "requester.subject": actor.subject,
    status: "superseded",
    decided_at: now,
  } as never).toArray();
  await Promise.all(replaced.map((request) =>
    archivePublicationRequestNotification(request._id)
  ));
  if (applyingAfterUpdate) {
    throw new ApiError(
      "This request is already being approved. Try again in a moment.",
      409,
      "PUBLICATION_APPLY_IN_PROGRESS",
    );
  }
  return result.modifiedCount;
}

function connectorItemId(
  request: PublicationRequestDocument,
): string | null {
  if (request.resource.kind === "webex_space") {
    return typeof request.requested_state.space_id === "string"
      ? request.requested_state.space_id
      : null;
  }
  if (request.resource.kind !== "slack_channel") return null;
  const defaults = request.requested_state.channel_defaults;
  if (!Array.isArray(defaults)) return null;
  const first = defaults[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return null;
  const row = first as Record<string, unknown>;
  return typeof row.channel_id === "string"
    ? row.channel_id
    : typeof row.id === "string"
      ? row.id
      : null;
}

/** One batched lookup used to annotate connector discovery pages. */
export async function activeConnectorPublicationRequestsByItemId(
  kind: "slack_channel" | "webex_space",
  itemIds: string[],
): Promise<Map<string, PublicationRequestDocument>> {
  const ids = normalizedStrings(itemIds);
  if (ids.length === 0) return new Map();
  const itemField = kind === "slack_channel"
    ? "requested_state.channel_defaults.channel_id"
    : "requested_state.space_id";
  const collection = await getCollection<PublicationRequestDocument>(REQUEST_COLLECTION);
  const requests = await collection
    .find({
      "resource.kind": kind,
      status: { $in: ACTIVE_STATUSES },
      [itemField]: { $in: ids },
    } as never)
    .sort({ updated_at: -1, _id: -1 })
    .limit(ids.length)
    .toArray();
  const result = new Map<string, PublicationRequestDocument>();
  for (const request of requests) {
    const itemId = connectorItemId(request);
    if (itemId && !result.has(itemId)) result.set(itemId, request);
  }
  return result;
}

export function connectorPublicationRequestView(
  request: PublicationRequestDocument,
  viewer: PublicationActor,
): PendingConnectorPublicationRequestView {
  if (request.status !== "pending" && request.status !== "applying") {
    throw new ApiError("Connector request is no longer pending", 409);
  }
  return {
    id: request._id,
    status: request.status,
    requester: request.requester,
    requester_is_viewer: request.requester.subject === viewer.subject,
    team_slug: typeof request.requested_state.team_slug === "string"
      ? request.requested_state.team_slug
      : "",
    agent_id: typeof request.requested_state.agent_id === "string"
      ? request.requested_state.agent_id
      : "",
    ...(typeof request.requested_state.bot_id === "string"
      ? { bot_id: request.requested_state.bot_id }
      : {}),
    approver_team_slugs: request.approver_team_slugs,
    approver_user_subjects: request.approver_user_subjects ?? [],
  };
}

/**
 * Invalidate collection proposals that reference a datasource being retired.
 *
 * Pending proposals are cancelled before the delete proceeds. Checking for an
 * applying request after that atomic update closes the acquire/delete race:
 * an approver that acquired first makes deletion retryable, while an approver
 * that arrives later can no longer acquire the superseded proposal.
 */
export async function invalidatePublicationRequestsReferencingDatasource(
  datasourceId: string,
  actor: PublicationActor,
  note = "A referenced datasource was deleted.",
): Promise<number> {
  const collection = await getCollection<PublicationRequestDocument>(REQUEST_COLLECTION);
  const now = new Date().toISOString();
  const resourceQuery = {
    "resource.kind": "rag_collection",
    "requested_state.source_ids": datasourceId,
  };
  const result = await collection.updateMany(
    { ...resourceQuery, status: "pending" } as never,
    {
      $set: { status: "superseded", updated_at: now, decided_at: now },
      $push: {
        history: auditEntry("superseded", actor, now, {
          note,
          from_status: "pending",
          to_status: "superseded",
        }),
      },
    } as never,
  );
  const applying = await collection.findOne({
    ...resourceQuery,
    status: "applying",
  } as never);
  const invalidated = await collection.find({
    ...resourceQuery,
    status: "superseded",
    decided_at: now,
  } as never).toArray();
  await Promise.all(invalidated.map((request) =>
    archivePublicationRequestNotification(request._id)
  ));
  if (applying) {
    throw new ApiError(
      "An approval that references this datasource is being applied. Try again in a moment.",
      409,
      "PUBLICATION_APPLY_IN_PROGRESS",
    );
  }
  return result.modifiedCount;
}

export async function getPublicationRequest(
  id: string,
): Promise<PublicationRequestDocument | null> {
  const collection = await getCollection<PublicationRequestDocument>(REQUEST_COLLECTION);
  return collection.findOne({ _id: id } as never);
}

async function recoverStaleApplyingRequests(): Promise<void> {
  const collection = await getCollection<PublicationRequestDocument>(REQUEST_COLLECTION);
  const cutoff = new Date(Date.now() - APPLY_LEASE_MS).toISOString();
  const stale = await collection
    .find({ status: "applying", apply_started_at: { $lte: cutoff } } as never)
    .limit(25)
    .toArray();
  for (const request of stale) {
    const started = [...request.history]
      .reverse()
      .find((entry) => entry.action === "approval_started");
    if (!started) continue;
    try {
      await revokeRequestApplyCapability(request, started.actor);
      const now = new Date().toISOString();
      await collection.updateOne(
        {
          _id: request._id,
          status: "applying",
          apply_started_at: request.apply_started_at,
        } as never,
        {
          $set: {
            status: "pending",
            updated_at: now,
            last_error: "A previous approval attempt timed out and can be retried.",
          },
          $unset: { apply_started_at: "" },
          $push: {
            history: auditEntry("apply_failed", started.actor, now, {
              note: "Approval apply lease expired.",
              from_status: "applying",
              to_status: "pending",
            }),
          },
        } as never,
      );
    } catch (error) {
      console.error(
        `[publication-approval] could not recover stale request ${request._id}`,
        error,
      );
    }
  }
}

interface PublicationReviewerAccess {
  query: Record<string, unknown> | null;
  canApprove: boolean;
  canManage: boolean;
}

function reviewerSelected(
  actor: PublicationActor,
  memberships: Set<string>,
  users: string[],
  teams: string[],
): boolean {
  return users.includes(actor.subject) || teams.some((slug) => memberships.has(slug));
}

async function publicationReviewerAccess(
  actor: PublicationActor,
): Promise<PublicationReviewerAccess> {
  const canManage = await canManagePublicationSettings(actor);
  if (canManage) return { query: {}, canApprove: true, canManage: true };
  const canApprove = await hasGlobalPublicationApproval(actor);
  if (!canApprove) return { query: null, canApprove: false, canManage: false };

  const [settings, teamSlugs] = await Promise.all([
    getPublicationApprovalSettings(),
    listPublicationActorTeamSlugs(actor, "member"),
  ]);
  const memberships = new Set(teamSlugs);
  const clauses: Record<string, unknown>[] = [];

  if (reviewerSelected(
    actor,
    memberships,
    settings.slack_reviewer_user_subjects,
    settings.slack_reviewer_team_slugs,
  )) {
    clauses.push({ "resource.kind": "slack_channel" });
  }
  if (reviewerSelected(
    actor,
    memberships,
    settings.webex_reviewer_user_subjects,
    settings.webex_reviewer_team_slugs,
  )) {
    clauses.push({ "resource.kind": "webex_space" });
  }

  const ragKinds: PublicationResourceKind[] = ["rag_datasource", "rag_collection"];
  const ragGlobalTeams = Array.from(new Set([
    ...settings.rag_reviewer_team_slugs,
    ...(settings.rag_reviewer_team_delegations["*"] ?? []),
  ]));
  const ragGlobalUsers = Array.from(new Set([
    ...settings.rag_reviewer_user_subjects,
    ...(settings.rag_reviewer_user_delegations["*"] ?? []),
  ]));
  if (reviewerSelected(actor, memberships, ragGlobalUsers, ragGlobalTeams)) {
    clauses.push({ "resource.kind": { $in: ragKinds } });
  } else {
    const targetTeams = Array.from(new Set([
      ...Object.keys(settings.rag_reviewer_team_delegations),
      ...Object.keys(settings.rag_reviewer_user_delegations),
    ]))
      .filter((target) => target !== "*")
      .filter((target) => reviewerSelected(
        actor,
        memberships,
        settings.rag_reviewer_user_delegations[target] ?? [],
        settings.rag_reviewer_team_delegations[target] ?? [],
      ));
    if (targetTeams.length > 0) {
      clauses.push({
        "resource.kind": { $in: ragKinds },
        "risk_facts.target_team_slugs": { $in: targetTeams },
      });
    }
  }

  return {
    query: clauses.length > 0 ? { $or: clauses } : null,
    canApprove: canApprove && clauses.length > 0,
    canManage: false,
  };
}

function publicationRequestFilter(
  actor: PublicationActor,
  options: PublicationRequestListOptions,
): Record<string, unknown> {
  const statuses = options.statuses?.length ? options.statuses : undefined;
  const kinds = options.kinds?.length ? options.kinds : undefined;
  const resourceIds = options.resourceIds?.length ? options.resourceIds : undefined;
  const requestIds = options.requestIds?.length ? options.requestIds : undefined;
  return {
    ...(requestIds ? { _id: { $in: requestIds } } : {}),
    ...(statuses ? { status: { $in: statuses } } : {}),
    ...(kinds ? { "resource.kind": { $in: kinds } } : {}),
    ...(resourceIds ? { "resource.id": { $in: resourceIds } } : {}),
    ...(options.mine ? { "requester.subject": actor.subject } : {}),
  };
}

export async function listPublicationRequestsPageForActor(
  actor: PublicationActor,
  options: PublicationRequestPageOptions = {},
): Promise<PublicationRequestPage> {
  await recoverStaleApplyingRequests();
  const collection = await getCollection<PublicationRequestDocument>(REQUEST_COLLECTION);
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 20)));
  const requestedPage = Math.max(1, Math.floor(options.page ?? 1));
  const base = publicationRequestFilter(actor, options);
  const access = options.mine
    ? { query: {}, canApprove: false, canManage: false }
    : await publicationReviewerAccess(actor);
  if (!access.query) {
    return {
      requests: [],
      pagination: { page: 1, page_size: pageSize, total: 0, total_pages: 1 },
    };
  }
  const query = Object.keys(access.query).length > 0
    ? { $and: [base, access.query] }
    : base;
  const total = await collection.countDocuments(query as never);
  const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);
  const page = Math.min(requestedPage, totalPages);
  const requests = await collection
    .find(query as never)
    .sort({ created_at: -1, _id: -1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .toArray();
  return {
    requests,
    pagination: {
      page,
      page_size: pageSize,
      total,
      total_pages: totalPages,
    },
  };
}

export async function acquirePublicationRequestForApproval(
  id: string,
  actor: PublicationActor,
): Promise<PublicationRequestDocument> {
  await recoverStaleApplyingRequests();
  const collection = await getCollection<PublicationRequestDocument>(REQUEST_COLLECTION);
  const request = await collection.findOne({ _id: id } as never);
  if (!request) throw new ApiError("Publication request not found", 404, "REQUEST_NOT_FOUND");
  if (!(await canApprovePublicationRequest(actor, request))) {
    throw new ApiError("You are not an approver for this request", 403, "APPROVAL_FORBIDDEN");
  }
  const settings = await getPublicationApprovalSettings();
  const requesterIsOrganizationAdmin =
    request.risk_facts.organization_wide &&
    request.requester.subject === actor.subject
      ? await canManagePublicationSettings(actor)
      : false;
  if (
    request.risk_facts.organization_wide &&
    request.requester.subject === actor.subject &&
    !settings.allow_organization_wide_self_approval &&
    !requesterIsOrganizationAdmin
  ) {
    throw new ApiError(
      "Organization-wide publication must be approved by someone other than the requester",
      403,
      "SELF_APPROVAL_FORBIDDEN",
    );
  }
  const now = new Date().toISOString();
  const acquired = await collection.findOneAndUpdate(
    { _id: id, status: "pending" } as never,
    {
      $set: { status: "applying", apply_started_at: now, updated_at: now },
      $push: {
        history: auditEntry("approval_started", actor, now, {
          from_status: "pending",
          to_status: "applying",
        }),
      },
    } as never,
    { returnDocument: "after" },
  );
  if (!acquired) {
    throw new ApiError(
      `This request is already ${request.status}`,
      409,
      "REQUEST_NOT_PENDING",
    );
  }
  try {
    await grantRequestApplyCapability(acquired, actor);
  } catch (error) {
    const failedAt = new Date().toISOString();
    await collection.updateOne(
      { _id: id, status: "applying" } as never,
      {
        $set: {
          status: "pending",
          updated_at: failedAt,
          last_error: "The request-scoped approval grant could not be established.",
        },
        $unset: { apply_started_at: "" },
        $push: {
          history: auditEntry("apply_failed", actor, failedAt, {
            note: "The request-scoped approval grant could not be established.",
            from_status: "applying",
            to_status: "pending",
          }),
        },
      } as never,
    );
    throw error;
  }
  return acquired;
}

export async function completePublicationApproval(
  id: string,
  actor: PublicationActor,
  note?: string,
): Promise<PublicationRequestDocument> {
  const collection = await getCollection<PublicationRequestDocument>(REQUEST_COLLECTION);
  const now = new Date().toISOString();
  const applying = await collection.findOne({ _id: id, status: "applying" } as never);
  if (!applying) throw new ApiError("Publication request is no longer applying", 409);
  await revokeRequestApplyCapability(applying, actor);
  const updated = await collection.findOneAndUpdate(
    { _id: id, status: "applying" } as never,
    {
      $set: {
        status: "approved",
        updated_at: now,
        decided_at: now,
        decided_by: actor,
        ...(note ? { decision_note: note } : {}),
      },
      $unset: { last_error: "", apply_started_at: "" },
      $push: {
        history: auditEntry("approved", actor, now, {
          note,
          from_status: "applying",
          to_status: "approved",
        }),
      },
    } as never,
    { returnDocument: "after" },
  );
  if (!updated) {
    await grantRequestApplyCapability(applying, actor).catch(() => {});
    throw new ApiError("Publication request is no longer applying", 409);
  }
  await notifyPublicationRequestDecision(updated, "approved", actor);
  return updated;
}

export async function failPublicationApproval(
  id: string,
  actor: PublicationActor,
  error: unknown,
): Promise<void> {
  const collection = await getCollection<PublicationRequestDocument>(REQUEST_COLLECTION);
  const now = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  const applying = await collection.findOne({ _id: id, status: "applying" } as never);
  if (applying) {
    try {
      await revokeRequestApplyCapability(applying, actor);
    } catch (cleanupError) {
      // Fail closed: as long as the temporary OpenFGA capability may still
      // exist, keep the request locked in `applying`. Stale-lease recovery
      // retries revocation before making the request approvable again.
      const cleanupMessage = cleanupError instanceof Error
        ? cleanupError.message
        : String(cleanupError);
      await collection.updateOne(
        { _id: id, status: "applying" } as never,
        {
          $set: {
            updated_at: now,
            last_error: `${message}; apply-capability cleanup failed: ${cleanupMessage}`
              .slice(0, 2000),
          },
          $push: {
            history: auditEntry("apply_failed", actor, now, {
              note: "The apply failed and its temporary capability is still being cleaned up.",
              from_status: "applying",
              to_status: "applying",
            }),
          },
        } as never,
      );
      console.error(
        "[publication-approval] failed to revoke request-scoped apply grant",
        cleanupError,
      );
      return;
    }
  }
  await collection.updateOne(
    { _id: id, status: "applying" } as never,
    {
      $set: { status: "pending", updated_at: now, last_error: message.slice(0, 2000) },
      $unset: { apply_started_at: "" },
      $push: {
        history: auditEntry("apply_failed", actor, now, {
          note: message.slice(0, 500),
          from_status: "applying",
          to_status: "pending",
        }),
      },
    } as never,
  );
}

export async function supersedeApplyingPublicationRequest(
  id: string,
  actor: PublicationActor,
  note: string,
): Promise<PublicationRequestDocument> {
  const collection = await getCollection<PublicationRequestDocument>(REQUEST_COLLECTION);
  const applying = await collection.findOne({ _id: id, status: "applying" } as never);
  if (!applying) throw new ApiError("Publication request is no longer applying", 409);
  await revokeRequestApplyCapability(applying, actor);
  const now = new Date().toISOString();
  const updated = await collection.findOneAndUpdate(
    { _id: id, status: "applying" } as never,
    {
      $set: {
        status: "superseded",
        updated_at: now,
        decided_at: now,
        decided_by: actor,
        decision_note: note,
      },
      $unset: { apply_started_at: "" },
      $push: {
        history: auditEntry("superseded", actor, now, {
          note,
          from_status: "applying",
          to_status: "superseded",
        }),
      },
    } as never,
    { returnDocument: "after" },
  );
  if (!updated) {
    await grantRequestApplyCapability(applying, actor).catch(() => {});
    throw new ApiError("Publication request is no longer applying", 409);
  }
  await archivePublicationRequestNotification(updated._id);
  return updated;
}

export async function rejectPublicationRequest(
  id: string,
  actor: PublicationActor,
  note: string,
): Promise<PublicationRequestDocument> {
  const collection = await getCollection<PublicationRequestDocument>(REQUEST_COLLECTION);
  const request = await collection.findOne({ _id: id } as never);
  if (!request) throw new ApiError("Publication request not found", 404, "REQUEST_NOT_FOUND");
  if (!(await canApprovePublicationRequest(actor, request))) {
    throw new ApiError("You are not an approver for this request", 403, "APPROVAL_FORBIDDEN");
  }
  const now = new Date().toISOString();
  const updated = await collection.findOneAndUpdate(
    { _id: id, status: "pending" } as never,
    {
      $set: {
        status: "rejected",
        updated_at: now,
        decided_at: now,
        decided_by: actor,
        decision_note: note,
      },
      $push: {
        history: auditEntry("rejected", actor, now, {
          note,
          from_status: "pending",
          to_status: "rejected",
        }),
      },
    } as never,
    { returnDocument: "after" },
  );
  if (!updated) throw new ApiError(`This request is already ${request.status}`, 409);
  await notifyPublicationRequestDecision(updated, "rejected", actor);
  return updated;
}

export async function cancelPublicationRequest(
  id: string,
  actor: PublicationActor,
): Promise<PublicationRequestDocument> {
  const collection = await getCollection<PublicationRequestDocument>(REQUEST_COLLECTION);
  const request = await collection.findOne({ _id: id } as never);
  if (!request) {
    throw new ApiError("Publication request not found", 404, "REQUEST_NOT_FOUND");
  }
  if (request.requester.subject !== actor.subject) {
    throw new ApiError(
      "Only the requester can withdraw this request",
      403,
      "WITHDRAW_FORBIDDEN",
    );
  }
  const now = new Date().toISOString();
  const updated = await collection.findOneAndUpdate(
    { _id: id, status: "pending" } as never,
    {
      $set: {
        status: "cancelled",
        updated_at: now,
        decided_at: now,
        decided_by: actor,
      },
      $push: {
        history: auditEntry("cancelled", actor, now, {
          note: "Withdrawn by the requester.",
          from_status: "pending",
          to_status: "cancelled",
        }),
      },
    } as never,
    { returnDocument: "after" },
  );
  if (!updated) {
    throw new ApiError(
      request.status === "applying"
        ? "This request is already being approved and can no longer be withdrawn"
        : `This request is already ${request.status}`,
      409,
      "REQUEST_NOT_PENDING",
    );
  }
  await archivePublicationRequestNotification(updated._id);
  return updated;
}

export async function publicationRequestSummary(
  actor: PublicationActor,
): Promise<PublicationRequestSummary> {
  await recoverStaleApplyingRequests();
  const collection = await getCollection<PublicationRequestDocument>(REQUEST_COLLECTION);
  const access = await publicationReviewerAccess(actor);
  const reviewerQuery = access.query && Object.keys(access.query).length > 0
    ? { $and: [{ status: { $in: ACTIVE_STATUSES } }, access.query] }
    : access.query
      ? { status: { $in: ACTIVE_STATUSES } }
      : null;
  const [pendingCount, requesterPendingCount] = await Promise.all([
    reviewerQuery
      ? collection.countDocuments(reviewerQuery as never)
      : Promise.resolve(0),
    collection.countDocuments({
      "requester.subject": actor.subject,
      status: { $in: ACTIVE_STATUSES },
    } as never),
  ]);
  return {
    pending_count: pendingCount,
    requester_pending_count: requesterPendingCount,
    can_approve: access.canApprove,
    can_manage_settings: access.canManage,
  };
}

export { ACTIVE_STATUSES };
