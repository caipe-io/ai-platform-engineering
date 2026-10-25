"use client";

/**
 * <TeamOwnershipFields> — the canonical group-based access-control control
 * bundle (spec 2026-06-03-unified-shareable-resource-rbac, US1, contract
 * ui-component.md).
 * assisted-by Codex Codex-sonnet-4-6
 *
 * Renders, for any shareable resource (agent, datasource, MCP tool, future
 * types):
 *   - an owner-team picker (single-select; disabled on edit unless transfers
 *     are allowed, in which case changing it directly marks a transfer),
 *   - a share-with-teams multi-select,
 *   - a read-only creator (provenance) line,
 *   - a not-a-member transfer confirmation when transferring to a team the
 *     caller does not belong to.
 *
 * The component is **controlled** and does not persist — the host editor saves
 * with its own button (consistent with the agent editor's button-save).
 *
 * Layout flexibility: access controls can appear before the owner picker or
 * between ownership and sharing. The agent editor uses this to show visibility
 * first and sharing only for team-visible agents. Other editors can omit these
 * slots.
 */

import * as React from "react";

import { Label } from "@/components/ui/label";
import {
TeamMultiPicker,
TeamPicker,
type TeamPickerOption,
} from "@/components/ui/team-picker";

export interface TeamOwnershipFieldsProps {
  // ---- current values --------------------------------------------------
  ownerTeamSlug: string;
  sharedTeamSlugs: string[];
  /** Shown read-only for provenance/audit. */
  creatorSubject?: string | null;

  // ---- mode ------------------------------------------------------------
  /** Disables the owner picker on edit unless transfers are allowed. */
  isEditing: boolean;
  /** Allows owner picker edits on edit; changed values are treated as transfers. */
  allowTransfer?: boolean;
  /** Mark the owner field required (create flow); drives the inline error. */
  ownerRequired?: boolean;

  // ---- data ------------------------------------------------------------
  /** Teams shown in the share multi-select and used to resolve slugs. */
  availableTeams: TeamPickerOption[];
  /**
   * Teams shown in the owner picker, when the owner-eligible set differs from
   * the shareable set (e.g. the agent editor disables non-ownable teams and
   * suffixes the role). Defaults to `availableTeams`.
   */
  ownerTeamOptions?: TeamPickerOption[];
  /** Slugs of teams the caller belongs to — to detect "not a member of destination". */
  currentUserTeamSlugs: string[];

  // ---- callbacks -------------------------------------------------------
  onOwnerTeamChange: (slug: string) => void;
  onSharedTeamsChange: (slugs: string[]) => void;
  /** Called when an edit-mode owner change is confirmed. `confirmedNotMember`
   * is true when the caller acknowledged they are not a member of the destination team. */
  onTransfer?: (newOwnerSlug: string, confirmedNotMember: boolean) => void;

  disabled?: boolean;

  // ---- per-resource copy / layout -------------------------------------
  /** Singular noun for copy, e.g. "agent", "data source", "tool". Default "resource". */
  resourceNoun?: string;
  ownerLabel?: string;
  ownerHelpText?: React.ReactNode;
  shareLabel?: string;
  shareHelpText?: React.ReactNode;
  /** When false, the entire share section is hidden (e.g. agent visibility !== "team"). */
  showShare?: boolean;
  /** When false, hide the owner-team picker (personal/private resources). */
  showOwner?: boolean;
  /** Rendered before the owner block (for access scope selectors). */
  beforeOwner?: React.ReactNode;
  /** Rendered between the owner block and the share block (e.g. agent visibility toggle). */
  betweenOwnerAndShare?: React.ReactNode;
  /** Rendered at the bottom of the owner block (e.g. agent platform-admin warning). */
  ownerExtra?: React.ReactNode;
  /** Per-grant detail line in the effective-access preview. */
  renderGrantDetail?: (slug: string, kind: "owner" | "shared") => React.ReactNode;
  /**
   * Extra lines in the effective-access preview (e.g. `user:*` for platform
   * default agents). Shown above team grant lines.
   */
  extraGrantPreviewItems?: Array<{
    id: string;
    line: React.ReactNode;
    detail?: React.ReactNode;
  }>;
}

export function TeamOwnershipFields(props: TeamOwnershipFieldsProps) {
  const {
    ownerTeamSlug,
    sharedTeamSlugs,
    creatorSubject,
    isEditing,
    allowTransfer = false,
    ownerRequired = false,
    availableTeams,
    ownerTeamOptions,
    currentUserTeamSlugs,
    onOwnerTeamChange,
    onSharedTeamsChange,
    onTransfer,
    disabled = false,
    resourceNoun = "resource",
    ownerLabel = "Owner Team",
    ownerHelpText,
    shareLabel = "Share with Teams",
    shareHelpText,
    showShare = true,
    showOwner = true,
    beforeOwner,
    betweenOwnerAndShare,
    ownerExtra,
    // `renderGrantDetail` and `extraGrantPreviewItems` remain in the props
    // interface for caller compatibility but are no longer rendered (the
    // grant-preview block was removed).
  } = props;

  const ownerMissing = ownerRequired && !isEditing && !ownerTeamSlug?.trim();
  // On edit the picker is editable only when transfers are allowed; otherwise
  // it stays locked. On create it is always enabled (unless globally disabled).
  const ownerPickerDisabled = disabled || (isEditing && !allowTransfer);

  const shareOptions = availableTeams.filter(
    (t): t is TeamPickerOption & { slug: string } => Boolean(t.slug),
  );
  const ownerOptions = (ownerTeamOptions ?? availableTeams).filter(
    (t): t is TeamPickerOption & { slug: string } => Boolean(t.slug),
  );

  function handleOwnerChange(slug: string) {
    // On edit, changing the owner performs a transfer (with the not-a-member
    // confirm). On create there is no transfer — just set the owner.
    if (isEditing && allowTransfer && onTransfer) {
      const confirmedNotMember = !currentUserTeamSlugs.includes(slug);
      if (confirmedNotMember) {
        const ok = window.confirm(
          `You are not a member of "${slug}". Transferring ownership may remove your own access to this ${resourceNoun}. Continue?`,
        );
        if (!ok) return;
      }
      onOwnerTeamChange(slug);
      onTransfer(slug, confirmedNotMember);
      return;
    }
    onOwnerTeamChange(slug);
  }

  return (
    <div className="space-y-4">
      {beforeOwner}

      {/* Owner team ------------------------------------------------------ */}
      {showOwner && <div className="space-y-2 rounded-lg">
        <Label htmlFor="ownerTeam">
          {ownerLabel}{" "}
          {ownerRequired && !isEditing && (
            <span className="text-destructive">*</span>
          )}
        </Label>
        <TeamPicker
          id="ownerTeam"
          value={ownerTeamSlug}
          onChange={handleOwnerChange}
          disabled={ownerPickerDisabled}
          ariaInvalid={ownerMissing}
          ariaDescribedBy="owner-team-help"
          placeholder={`Select a team that will own this ${resourceNoun}`}
          searchPlaceholder="Search your teams..."
          emptyLabel={
            availableTeams.length === 0
              ? "You are not a member of any teams"
              : "No teams match"
          }
          options={ownerOptions}
        />
        <p id="owner-team-help" className="text-xs text-muted-foreground">
          {ownerHelpText ?? (
            <>
              Owner-team members can use and edit the {resourceNoun};
              owner-team admins can manage it.
            </>
          )}
        </p>
        {isEditing && allowTransfer && onTransfer && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Changing the owner team will transfer ownership when you save. If you are not a member of the destination team, saving may remove your own access.
          </p>
        )}
        {creatorSubject && (
          <p className="text-xs text-muted-foreground" data-testid="creator-subject">
            Created by <code>{creatorSubject}</code> (provenance only — does not
            grant access).
          </p>
        )}
        {ownerExtra}
      </div>}

      {betweenOwnerAndShare}

      {/* Share with teams ------------------------------------------------ */}
      {showShare && (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
          <Label className="text-sm">{shareLabel}</Label>
          {shareHelpText && (
            <p className="mb-3 text-xs text-muted-foreground">{shareHelpText}</p>
          )}
          {availableTeams.length === 0 ? (
            <p className="text-xs italic text-muted-foreground">
              You are not a member of any teams.
            </p>
          ) : (
            <TeamMultiPicker
              options={shareOptions}
              selected={sharedTeamSlugs}
              onChange={onSharedTeamsChange}
              disabled={disabled}
              placeholder="Pick one or more teams to share with..."
              searchPlaceholder="Search your teams..."
              emptyLabel="No teams match"
            />
          )}
        </div>
      )}
    </div>
  );
}

export default TeamOwnershipFields;
