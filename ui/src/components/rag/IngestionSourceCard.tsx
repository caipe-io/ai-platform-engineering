"use client";

/**
 * Per-source card for the Ingestion Sources tab
 * (spec 2026-07-21-rag-source-config-db).
 *
 * Badge markup mirrors `DynamicAgentsTab.tsx`'s config-driven Badge and
 * `getVisibilityIcon`/`getVisibilityColor` so operators have one visual
 * language for "loaded from config" and "team vs global" across dynamic
 * agents, MCP tools, and ingestion sources.
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { IngestionSourceConfigWithPermissions } from "@/types/ingestion-source";
import { Loader2, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { DatasourceAccessBadges } from "./DatasourceAccessBadges";
import type { PendingPublicationRequestView } from "@/types/publication-approval";

const TYPE_LABELS: Record<string, string> = {
  slack_channel: "Slack Channel",
  confluence_space: "Confluence",
  jira_project: "Jira Project",
  web_url: "Web URL",
  webex_space: "Webex Space",
};

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
  active: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30",
  disabled: "bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30",
  ingesting: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30",
  failed: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
};

function identityDetail(source: IngestionSourceConfigWithPermissions): string {
  switch (source.source_type) {
    case "slack_channel":
      return source.channel_id;
    case "confluence_space":
      return source.space_key;
    case "jira_project":
      return source.project_key;
    case "web_url":
      return source.url;
    case "webex_space":
      return source.space_id;
    default:
      return "";
  }
}

export interface IngestionSourceCardProps {
  source: IngestionSourceConfigWithPermissions;
  onEdit: (source: IngestionSourceConfigWithPermissions) => void;
  onDelete: (source: IngestionSourceConfigWithPermissions) => Promise<void>;
  onRetry?: (source: IngestionSourceConfigWithPermissions) => Promise<void>;
  pendingPublicationRequest?: PendingPublicationRequestView | null;
}

export function IngestionSourceCard({
  source,
  onEdit,
  onDelete,
  onRetry,
  pendingPublicationRequest,
}: IngestionSourceCardProps) {
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const canManage = source._permissions.can_manage;

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await onDelete(source);
    } finally {
      setDeleting(false);
      setPendingDelete(false);
    }
  };

  const handleRetry = async () => {
    if (!onRetry) return;
    setRetrying(true);
    try {
      await onRetry(source);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="rounded-xl border border-border/50 bg-card/50 p-4 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm truncate">{source.name}</span>
            <Badge variant="outline" className="text-xs font-mono shrink-0">
              {TYPE_LABELS[source.source_type] ?? source.source_type}
            </Badge>
            <Badge
              variant="outline"
              className={`text-xs shrink-0 ${STATUS_STYLES[source.status] ?? ""}`}
            >
              {source.status}
            </Badge>
            <DatasourceAccessBadges
              ownerTeamSlug={source.owner_team_slug}
              ownerSubject={source.owner_subject}
              ownerDisplayName={source.owner_display_name}
              searchTeamSlugs={
                source.search_with_teams
                ?? (source.search_owner_team_slug ? [source.search_owner_team_slug] : [])
              }
              searchUserDisplayNames={source.search_user_display_names}
              ragCollections={source.rag_collections}
              pendingPublicationRequest={pendingPublicationRequest}
              detailsKnown
            />
            {source.config_driven && (
              <Badge
                variant="outline"
                className="gap-1 bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30"
                title="Loaded from config.yaml - cannot be edited"
              >
                Config
              </Badge>
            )}
          </div>
          {source.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{source.description}</p>
          )}
          {source.status === "failed" && source.last_error && (
            <p className="text-xs text-destructive mt-1 line-clamp-2" title={source.last_error}>
              {source.last_error}
            </p>
          )}
          <p className="text-xs text-muted-foreground font-mono mt-1 truncate">
            {identityDetail(source)}
          </p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {canManage && onRetry && !source.config_driven && source.status === "failed" && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => void handleRetry()}
              disabled={retrying}
              title="Retry ingestion"
            >
              {retrying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              Retry
            </Button>
          )}
          {canManage && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onEdit(source)}
              title="Edit"
            >
              <Pencil className="h-4 w-4" />
            </Button>
          )}
          {canManage &&
            (pendingDelete ? (
              <div className="flex items-center gap-1 rounded-full border border-destructive/20 bg-destructive/10 px-2 py-1">
                <span className="max-w-[7rem] truncate text-xs font-medium text-destructive">
                  Delete {source.name}?
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                  disabled={deleting}
                  onClick={() => setPendingDelete(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  aria-label={`Confirm delete ${source.name}`}
                  className="h-7 bg-destructive px-2 text-xs text-destructive-foreground hover:bg-destructive/90"
                  disabled={deleting}
                  onClick={() => void handleDelete()}
                >
                  {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Delete"}
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive hover:text-destructive"
                onClick={() => setPendingDelete(true)}
                aria-label={`Delete ${source.name}`}
                title="Delete source"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            ))}
        </div>
      </div>
    </div>
  );
}

export default IngestionSourceCard;
