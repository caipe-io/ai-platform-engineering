"use client";

import { Database, Loader2, Save, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ImportRagSourcesFromConfigCard } from "@/components/admin/settings/ImportRagSourcesFromConfigCard";
import { RagIngestorLimitsEditor } from "@/components/admin/settings/RagIngestorLimitsEditor";
import { AdminBadge } from "@/components/admin/shared/AdminBadge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { TeamPicker, type TeamPickerOption } from "@/components/ui/team-picker";
import {
  normalizeRagIngestorLimits,
  type RagIngestorLimits,
} from "@/lib/rag-ingestor-limits";

interface TeamRow {
  _id?: string;
  slug?: string;
  name?: string;
}

interface RagSettingsTabProps {
  isAdmin: boolean;
  readOnly?: boolean;
}

/** Platform defaults and the one-time env-config migration for RAG. */
export function RagSettingsTab({
  isAdmin,
  readOnly = false,
}: RagSettingsTabProps) {
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [defaultSearchTeamSlug, setDefaultSearchTeamSlug] = useState("");
  const [savedSearchTeamSlug, setSavedSearchTeamSlug] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingLimits, setSavingLimits] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [limitsSaved, setLimitsSaved] = useState(false);
  const [ingestorLimits, setIngestorLimits] = useState<RagIngestorLimits>(() =>
    normalizeRagIngestorLimits(undefined),
  );
  const [savedIngestorLimits, setSavedIngestorLimits] =
    useState<RagIngestorLimits>(() => normalizeRagIngestorLimits(undefined));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetch("/api/admin/platform-config").then((response) => response.json()),
      fetch("/api/dynamic-agents/teams").then((response) => response.json()),
    ])
      .then(([config, teamResponse]) => {
        if (cancelled) return;
        if (!config?.success) {
          throw new Error(config?.error || "Could not load RAG settings");
        }
        const slug =
          typeof config.data?.rag_default_search_team_slug === "string"
            ? config.data.rag_default_search_team_slug
            : "";
        setDefaultSearchTeamSlug(slug);
        setSavedSearchTeamSlug(slug);
        const limits = normalizeRagIngestorLimits(
          config.data?.rag_ingestor_limits,
        );
        setIngestorLimits(limits);
        setSavedIngestorLimits(limits);
        if (teamResponse?.success && Array.isArray(teamResponse.data)) {
          setTeams(teamResponse.data);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Could not load RAG settings",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo<TeamPickerOption[]>(
    () =>
      teams
        .filter((team): team is TeamRow & { slug: string } =>
          Boolean(team.slug),
        )
        .map((team) => ({
          slug: team.slug,
          name: team.name ?? team.slug,
          _id: team._id,
        })),
    [teams],
  );

  async function saveSettings(): Promise<void> {
    if (readOnly || !isAdmin) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const response = await fetch("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rag_default_search_team_slug: defaultSearchTeamSlug || null,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result?.success) {
        throw new Error(
          result?.error || `Could not save RAG settings (${response.status})`,
        );
      }
      const slug =
        typeof result.data?.rag_default_search_team_slug === "string"
          ? result.data.rag_default_search_team_slug
          : "";
      setDefaultSearchTeamSlug(slug);
      setSavedSearchTeamSlug(slug);
      setSaved(true);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Could not save RAG settings",
      );
    } finally {
      setSaving(false);
    }
  }

  async function saveIngestorLimits(): Promise<void> {
    if (readOnly || !isAdmin) return;
    setSavingLimits(true);
    setLimitsSaved(false);
    setError(null);
    try {
      const response = await fetch("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rag_ingestor_limits: ingestorLimits }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result?.success) {
        throw new Error(
          result?.error ||
            `Could not save RAG ingestor policies (${response.status})`,
        );
      }
      const limits = normalizeRagIngestorLimits(
        result.data?.rag_ingestor_limits,
      );
      setIngestorLimits(limits);
      setSavedIngestorLimits(limits);
      if (
        Object.prototype.hasOwnProperty.call(
          result.data ?? {},
          "rag_default_search_team_slug",
        )
      ) {
        const slug =
          typeof result.data.rag_default_search_team_slug === "string"
            ? result.data.rag_default_search_team_slug
            : "";
        setDefaultSearchTeamSlug(slug);
        setSavedSearchTeamSlug(slug);
      }
      setLimitsSaved(true);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Could not save RAG ingestor policies",
      );
    } finally {
      setSavingLimits(false);
    }
  }

  const limitsChanged =
    JSON.stringify(ingestorLimits) !== JSON.stringify(savedIngestorLimits);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">RAG settings</h2>
        <AdminBadge />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            RAG Defaults
          </CardTitle>
          <CardDescription>
            Choose who gets Search access by default. Users can remove the
            default to keep a datasource personal.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="rag-default-search-team" className="block">
              Default Search team
            </Label>
            <TeamPicker
              id="rag-default-search-team"
              value={defaultSearchTeamSlug}
              onChange={(slug) => {
                setDefaultSearchTeamSlug(slug);
                setSaved(false);
              }}
              options={options}
              placeholder={
                loading ? "Loading teams…" : "None (personal by default)"
              }
              searchPlaceholder="Search teams..."
              emptyLabel="No teams match"
              disabled={
                loading ||
                saving ||
                readOnly ||
                !isAdmin ||
                ingestorLimits.shared.max_search_teams === 0
              }
            />
            <p className="text-xs text-muted-foreground">
              Members can search new datasources without becoming Owners.
            </p>
          </div>

          {saved && (
            <p
              role="status"
              className="text-sm text-emerald-600 dark:text-emerald-400"
            >
              RAG defaults saved.
            </p>
          )}

          <div className="flex justify-end">
            <Button
              type="button"
              onClick={() => void saveSettings()}
              disabled={
                loading ||
                saving ||
                readOnly ||
                !isAdmin ||
                defaultSearchTeamSlug === savedSearchTeamSlug
              }
              className="gap-2"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save RAG Defaults
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SlidersHorizontal className="h-5 w-5" />
            Ingestor Policies
          </CardTitle>
          <CardDescription>
            Set limits for datasources created by users.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <RagIngestorLimitsEditor
            value={ingestorLimits}
            onChange={(limits) => {
              setIngestorLimits(limits);
              setLimitsSaved(false);
            }}
            disabled={loading || savingLimits || readOnly || !isAdmin}
          />

          {limitsSaved && (
            <p
              role="status"
              className="text-sm text-emerald-600 dark:text-emerald-400"
            >
              RAG ingestor policies saved.
            </p>
          )}

          <div className="flex justify-end">
            <Button
              type="button"
              onClick={() => void saveIngestorLimits()}
              disabled={
                loading ||
                savingLimits ||
                readOnly ||
                !isAdmin ||
                !limitsChanged
              }
              className="gap-2"
            >
              {savingLimits ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save Ingestor Policies
            </Button>
          </div>
        </CardContent>
      </Card>

      <ImportRagSourcesFromConfigCard isAdmin={isAdmin} readOnly={readOnly} />
    </div>
  );
}

export default RagSettingsTab;
