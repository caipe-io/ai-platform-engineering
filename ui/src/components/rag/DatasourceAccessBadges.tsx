import { Badge } from "@/components/ui/badge";
import { Clock3, Search, User, Users } from "lucide-react";
import type { RagCollectionMembershipLabel } from "@/types/rag-collection";
import type { PendingPublicationRequestView } from "@/types/publication-approval";
import {
  effectiveSearchTeamSlugs,
  searchTeamLabel,
} from "./datasource-view-state";

interface DatasourceAccessBadgesProps {
  ownerTeamSlug?: string | null;
  ownerSubject?: string | null;
  ownerDisplayName?: string | null;
  searchTeamSlugs?: string[] | null;
  searchUserDisplayNames?: string[] | null;
  ragCollections?: RagCollectionMembershipLabel[] | null;
  pendingPublicationRequest?: PendingPublicationRequestView | null;
  detailsKnown: boolean;
  canReadContent?: boolean;
}

function normalizedTeams(teamSlugs?: string[] | null): string[] {
  return Array.from(
    new Set((teamSlugs ?? []).map((slug) => slug.trim()).filter(Boolean)),
  );
}

function compactList(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "No access";
  return `${labels[0]} +${labels.length - 1}`;
}

export function DatasourceAccessBadges({
  ownerTeamSlug,
  ownerSubject,
  ownerDisplayName,
  searchTeamSlugs,
  searchUserDisplayNames,
  ragCollections,
  pendingPublicationRequest,
  detailsKnown,
  canReadContent = false,
}: DatasourceAccessBadgesProps) {
  const ownerTeam = ownerTeamSlug?.trim();
  const searchTeams = effectiveSearchTeamSlugs({
    searchTeamSlugs,
    ragCollections,
  }).map(searchTeamLabel);
  const personal = !ownerTeam && Boolean(ownerSubject?.trim());
  const personalLabel = ownerDisplayName?.trim() || "Unknown user";
  const searchUsers = Array.from(
    new Set((searchUserDisplayNames ?? []).map((label) => label.trim()).filter(Boolean)),
  );
  const ownerLabel = ownerTeam
    ? ownerTeam
    : personal
      ? personalLabel
      : detailsKnown
        ? "Unassigned"
        : "Restricted";
  const ownerTitle = ownerTeam
    ? `Owner: ${ownerTeam}`
    : personal
      ? `Owner: ${personalLabel}`
      : detailsKnown
        ? "No owner is assigned"
        : "Owner details are not available with your access";

  const searchLabels = [
    ...(personal ? [personalLabel] : []),
    ...searchTeams,
    ...searchUsers,
  ];
  const searchLabel = searchLabels.length > 0
      ? compactList(searchLabels)
      : personal
        ? personalLabel
        : detailsKnown
          ? "No access"
          : canReadContent
            ? "Shared with you"
            : "Restricted";
  const searchTitle = searchLabels.length > 0
      ? `Search: ${searchLabels.join(", ")}`
      : personal
        ? `Search: ${personalLabel}`
        : detailsKnown
          ? "Search: no one assigned"
          : canReadContent
            ? "Search: this source is shared with you; details are restricted"
            : "Search details are restricted";
  const effectivePendingTeams = new Set(normalizedTeams(
    pendingPublicationRequest?.effective_state.search_team_slugs as string[] | undefined,
  ));
  const effectivePendingUsers = new Set(
    Array.isArray(pendingPublicationRequest?.effective_state.search_user_subjects)
      ? pendingPublicationRequest.effective_state.search_user_subjects.filter(
          (subject): subject is string => typeof subject === "string",
        )
      : [],
  );
  const pendingTeams = normalizedTeams(
    pendingPublicationRequest?.requested_state.search_team_slugs as string[] | undefined,
  )
    .filter((slug) => !effectivePendingTeams.has(slug))
    .map((slug) => slug.toLowerCase() === "everyone" ? "Everyone" : slug);
  const pendingUserCount = Array.isArray(
    pendingPublicationRequest?.requested_state.search_user_subjects,
  )
    ? pendingPublicationRequest.requested_state.search_user_subjects.filter(
        (subject): subject is string =>
          typeof subject === "string" && !effectivePendingUsers.has(subject),
      ).length
    : 0;
  const requestedPendingTeams = new Set(normalizedTeams(
    pendingPublicationRequest?.requested_state.search_team_slugs as string[] | undefined,
  ));
  const removedPendingTeams = [...effectivePendingTeams]
    .filter((slug) => !requestedPendingTeams.has(slug))
    .map((slug) => slug.toLowerCase() === "everyone" ? "Everyone" : slug);
  const addedPendingLabels = [
    ...pendingTeams,
    ...(pendingUserCount > 0
      ? [`${pendingUserCount} ${pendingUserCount === 1 ? "person" : "people"}`]
      : []),
  ];
  const pendingLabel = addedPendingLabels.length > 0 && removedPendingTeams.length > 0
    ? "Search change"
    : addedPendingLabels.length > 0
      ? compactList(addedPendingLabels)
      : removedPendingTeams.length > 0
        ? `remove ${compactList(removedPendingTeams)}`
        : "approval";
  const pendingTitleParts = [
    ...(addedPendingLabels.length > 0
      ? [`add ${addedPendingLabels.join(", ")}`]
      : []),
    ...(removedPendingTeams.length > 0
      ? [`remove ${removedPendingTeams.join(", ")}`]
      : []),
  ];
  const pendingTitle = addedPendingLabels.length > 0 && removedPendingTeams.length === 0
    ? `Pending Search: ${addedPendingLabels.join(", ")}`
    : pendingTitleParts.length > 0
      ? `Pending Search: ${pendingTitleParts.join("; ")}`
      : "A datasource change is waiting for approval";

  return (
    <>
      <Badge
        variant="outline"
        className="max-w-44 shrink-0 gap-1 border-blue-500/30 bg-blue-500/10 text-[10px] text-blue-700 dark:text-blue-300"
        title={ownerTitle}
      >
        {personal ? <User className="h-3 w-3 shrink-0" /> : <Users className="h-3 w-3 shrink-0" />}
        <span className="truncate">Owner: {ownerLabel}</span>
      </Badge>
      <Badge
        variant="outline"
        className="max-w-52 shrink-0 gap-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-300"
        title={searchTitle}
      >
        <Search className="h-3 w-3 shrink-0" />
        <span className="truncate">Search: {searchLabel}</span>
      </Badge>
      {pendingPublicationRequest && (
        <Badge
          variant="outline"
          className="max-w-52 shrink-0 gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-300"
          title={pendingTitle}
        >
          <Clock3 className="h-3 w-3 shrink-0" />
          <span className="truncate">Pending: {pendingLabel}</span>
        </Badge>
      )}
    </>
  );
}
