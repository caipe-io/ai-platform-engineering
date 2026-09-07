"use client";

/**
 * Admin -> Settings -> Agents pane for adopting YAML-seeded dynamic agents
 * into the DB as source of truth (spec: config-driven agents currently
 * re-seeded from APP_CONFIG_PATH on every restart via seed-config.ts).
 *
 * Flow: open the popover -> preview (dry_run) lists every agent id in the
 * YAML seed file alongside its current Mongo adoption state -> admin picks
 * which of the still-importable ones to adopt plus an optional owner team
 * and shared teams -> apply calls the same endpoint with dry_run:false,
 * which sets config_import_adopted:true on exactly the chosen ids and
 * applies the team assignment ONLY to those ids (never retroactively to
 * agents outside the batch).
 */

import { AlertTriangle, FileUp, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { TeamOwnershipFields } from "@/components/rbac/TeamOwnershipFields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type TeamPickerOption } from "@/components/ui/team-picker";

interface PreviewAgent {
  id: string;
  name: string;
  description?: string;
  in_db: boolean;
  already_adopted: boolean;
}

interface TeamOption {
  _id: string;
  name: string;
  slug?: string;
  user_role?: string | null;
  can_own_agents?: boolean;
}

interface ImportAgentsFromConfigCardProps {
  isAdmin: boolean;
  readOnly?: boolean;
}

export function ImportAgentsFromConfigCard({
  isAdmin,
  readOnly = false,
}: ImportAgentsFromConfigCardProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewAgents, setPreviewAgents] = useState<PreviewAgent[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [availableTeams, setAvailableTeams] = useState<TeamOption[]>([]);
  const [ownerTeamSlug, setOwnerTeamSlug] = useState("");
  const [sharedWithTeams, setSharedWithTeams] = useState<string[]>([]);
  const [result, setResult] = useState<{ adopted: string[]; skipped: string[] } | null>(null);

  const importable = previewAgents.filter((a) => a.in_db && !a.already_adopted);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    (async () => {
      try {
        const [previewRes, teamsRes] = await Promise.all([
          fetch("/api/admin/dynamic-agents/runtime/sync-from-config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dry_run: true }),
          }).then((r) => r.json()),
          fetch("/api/dynamic-agents/teams").then((r) => r.json()),
        ]);
        if (cancelled) return;
        if (previewRes.success) {
          const agents = (previewRes.data?.agents ?? []) as PreviewAgent[];
          setPreviewAgents(agents);
          setSelectedIds(
            new Set(agents.filter((a) => a.in_db && !a.already_adopted).map((a) => a.id)),
          );
        } else {
          setError(previewRes.error || "Failed to preview config");
        }
        if (teamsRes.success && Array.isArray(teamsRes.data)) {
          setAvailableTeams(teamsRes.data);
        }
      } catch {
        if (!cancelled) setError("Network error loading preview");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleApply() {
    if (readOnly) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/dynamic-agents/runtime/sync-from-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dry_run: false,
          agent_ids: Array.from(selectedIds),
          owner_team_slug: ownerTeamSlug || null,
          shared_with_teams: sharedWithTeams,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Import failed");
        return;
      }
      setResult({ adopted: data.data.adopted ?? [], skipped: data.data.skipped ?? [] });
      setPreviewAgents((prev) =>
        prev.map((a) =>
          data.data.adopted?.includes(a.id) ? { ...a, already_adopted: true } : a,
        ),
      );
      setSelectedIds(new Set());
    } catch {
      setError("Network error applying import");
    } finally {
      setApplying(false);
    }
  }

  if (!isAdmin) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Import Agents from Config
        </CardTitle>
        <CardDescription>
          Adopt YAML-seeded dynamic agents into the database. Once adopted, an agent&apos;s
          config-file entry is ignored on every future restart — the database becomes the
          source of truth for it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          onClick={() => {
            if (!readOnly) setOpen(true);
          }}
          disabled={readOnly}
          data-testid="import-agents-from-config-button"
        >
          <FileUp className="h-4 w-4" />
          Import from YAML
        </Button>
      </CardContent>

      <Dialog open={open} onOpenChange={(next) => !applying && setOpen(next)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Import agents from config</DialogTitle>
            <DialogDescription>
              Pick the config-driven agents to adopt and, optionally, a team to own and share
              them with. This assignment applies only to the agents selected below.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-4">
              {error && (
                <div
                  className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                  data-testid="import-agents-error"
                >
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  {error}
                </div>
              )}

              {result && (
                <div
                  className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
                  data-testid="import-agents-result"
                >
                  Adopted {result.adopted.length} agent{result.adopted.length === 1 ? "" : "s"}.
                  {result.skipped.length > 0 && ` Skipped ${result.skipped.length} (already adopted or not config-driven).`}
                </div>
              )}

              {previewAgents.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No agents found in the config file, or none are eligible for import.
                </p>
              ) : (
                <div
                  className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2"
                  data-testid="import-agents-checklist"
                >
                  {previewAgents.map((agent) => (
                    <label
                      key={agent.id}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.has(agent.id)}
                        disabled={!agent.in_db || agent.already_adopted}
                        onChange={() => toggleSelected(agent.id)}
                        data-testid={`import-agent-checkbox-${agent.id}`}
                      />
                      <span className="flex-1 truncate">{agent.name}</span>
                      {agent.already_adopted && (
                        <Badge variant="secondary" className="shrink-0">
                          Already adopted
                        </Badge>
                      )}
                      {!agent.in_db && !agent.already_adopted && (
                        <Badge variant="outline" className="shrink-0">
                          Not seeded yet
                        </Badge>
                      )}
                    </label>
                  ))}
                </div>
              )}

              {importable.length > 0 && (
                <TeamOwnershipFields
                  ownerTeamSlug={ownerTeamSlug}
                  sharedTeamSlugs={sharedWithTeams}
                  isEditing={false}
                  ownerRequired={false}
                  resourceNoun="imported agent batch"
                  currentUserTeamSlugs={availableTeams
                    .map((t) => t.slug)
                    .filter((slug): slug is string => Boolean(slug))}
                  onOwnerTeamChange={setOwnerTeamSlug}
                  onSharedTeamsChange={setSharedWithTeams}
                  availableTeams={availableTeams
                    .filter((t): t is TeamOption & { slug: string } => Boolean(t.slug))
                    .map<TeamPickerOption>((t) => ({ slug: t.slug, name: t.name, _id: t._id }))}
                  ownerTeamOptions={availableTeams
                    .filter((t): t is TeamOption & { slug: string } => Boolean(t.slug))
                    .map<TeamPickerOption>((t) => ({
                      slug: t.slug,
                      name: t.user_role ? `${t.name} (${t.user_role})` : t.name,
                      _id: t._id,
                      disabled: t.can_own_agents === false,
                    }))}
                  ownerHelpText="Optional — leave unset to import without changing ownership on these agents."
                  shareHelpText="Additional teams that can use the imported agents."
                  disabled={applying}
                />
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={applying}>
              Close
            </Button>
            <Button
              type="button"
              onClick={handleApply}
              disabled={loading || applying || selectedIds.size === 0}
              className="gap-2"
              data-testid="import-agents-apply-button"
            >
              {applying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Import {selectedIds.size > 0 ? selectedIds.size : ""} agent
              {selectedIds.size === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default ImportAgentsFromConfigCard;
