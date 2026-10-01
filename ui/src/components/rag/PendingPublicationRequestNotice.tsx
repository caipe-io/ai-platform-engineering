"use client";

import { Button } from "@/components/ui/button";
import type {
  AccessSubjectOption,
} from "@/components/ui/access-subject-picker";
import { useToast } from "@/components/ui/toast";
import type { PendingPublicationRequestView } from "@/types/publication-approval";
import { Clock3, Loader2 } from "lucide-react";
import React from "react";

interface TeamLabel {
  slug: string;
  name?: string;
}

interface PendingPublicationRequestNoticeProps {
  request: PendingPublicationRequestView;
  teams?: TeamLabel[];
  knownUsers?: AccessSubjectOption[];
  onWithdrawn?: () => void | Promise<void>;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

export function PendingPublicationRequestNotice({
  request,
  teams = [],
  knownUsers = [],
  onWithdrawn,
}: PendingPublicationRequestNoticeProps) {
  const { toast } = useToast();
  const [withdrawing, setWithdrawing] = React.useState(false);
  const effectiveTeams = new Set(stringList(request.effective_state.search_team_slugs));
  const effectiveUsers = new Set(stringList(request.effective_state.search_user_subjects));
  const addedTeams = stringList(request.requested_state.search_team_slugs).filter(
    (slug) => !effectiveTeams.has(slug),
  );
  const addedUsers = stringList(request.requested_state.search_user_subjects).filter(
    (subject) => !effectiveUsers.has(subject),
  );
  const requestedTeams = new Set(stringList(request.requested_state.search_team_slugs));
  const removedTeams = [...effectiveTeams].filter((slug) => !requestedTeams.has(slug));
  const teamLabels = addedTeams.map(
    (slug) => teams.find((team) => team.slug === slug)?.name ?? slug,
  );
  const userLabels = addedUsers.map((subject) => {
    const user = knownUsers.find((candidate) => candidate.id === subject);
    return user?.name || user?.email || null;
  });
  const namedUsers = userLabels.filter((label): label is string => Boolean(label));
  const unknownUserCount = userLabels.length - namedUsers.length;
  const audienceLabels = [
    ...teamLabels,
    ...namedUsers,
    ...(unknownUserCount > 0
      ? [`${unknownUserCount} ${unknownUserCount === 1 ? "person" : "people"}`]
      : []),
  ];
  const removedTeamLabels = removedTeams.map(
    (slug) => teams.find((team) => team.slug === slug)?.name ?? slug,
  );
  const includesSearchChanges = audienceLabels.length > 0 || removedTeamLabels.length > 0;
  const includesSourceChanges = Boolean(
    request.requested_state.source_update &&
    typeof request.requested_state.source_update === "object",
  );
  const includesOwnerChange = Boolean(
    request.requested_state.owner_update &&
    typeof request.requested_state.owner_update === "object",
  );

  const withdraw = async () => {
    setWithdrawing(true);
    try {
      const response = await fetch(
        `/api/publication-requests/${encodeURIComponent(request.id)}/cancel`,
        { method: "POST" },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error || body?.data?.error || "Could not withdraw the request");
      }
      toast("Change request withdrawn.", "success");
      await onWithdrawn?.();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Could not withdraw the request",
        "error",
        6000,
      );
    } finally {
      setWithdrawing(false);
    }
  };

  return (
    <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 text-xs">
      <div className="flex items-start gap-2">
        <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium text-foreground">Waiting for approval</p>
          {audienceLabels.length > 0 && (
            <p className="text-foreground">
              Requested Search: {audienceLabels.join(", ")}
            </p>
          )}
          {removedTeamLabels.length > 0 && (
            <p className="text-foreground">
              Requested Search removal: {removedTeamLabels.join(", ")}
            </p>
          )}
          {includesSourceChanges && (
            <p className="text-foreground">Datasource settings are also included.</p>
          )}
          {includesOwnerChange && (
            <p className="text-foreground">An Owner change is also included.</p>
          )}
          <p className="text-muted-foreground">
            {includesSearchChanges && includesSourceChanges
              ? "Current Search access and datasource settings stay the same until this request is approved."
              : includesSearchChanges
                ? "Current Search access stays the same until this request is approved."
                : includesOwnerChange
                  ? "The current Owner stays the same until this request is approved."
                  : "Current datasource settings stay the same until this request is approved."}
          </p>
        </div>
        {request.status === "pending" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0"
            disabled={withdrawing}
            onClick={() => void withdraw()}
          >
            {withdrawing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Withdraw request
          </Button>
        ) : (
          <span className="shrink-0 text-muted-foreground">Applying…</span>
        )}
      </div>
    </div>
  );
}
