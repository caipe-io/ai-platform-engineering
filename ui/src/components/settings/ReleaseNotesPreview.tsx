"use client";

import { hasReleaseNotesOverride } from "@/lib/release-notes-override";
import { ReleaseUpgradeDialog } from "@/components/release/ReleaseUpgradeDialog";
import { Button } from "@/components/ui/button";
import {
  hasConfiguredReleaseNotesCompare,
  releaseNotesRequestUrl,
  type ReleaseMarkdown,
  type ReleaseNote,
  type ReleaseNotesNotificationConfig,
} from "@/hooks/use-release-upgrade-prompt";
import { Eye,Loader2 } from "lucide-react";
import { useState } from "react";

function normalizeVersion(value?: string | null): string | null {
  const version = value?.trim().replace(/^v/,"");
  return version || null;
}

function baseVersion(value: string): string {
  return value.trim().replace(/^v/i,"").split(/[-+]/)[0];
}

export function ReleaseNotesPreview({ isAdmin }: { isAdmin: boolean }): React.ReactElement {
  const [error,setError] = useState<string | null>(null);
  const [open,setOpen] = useState(false);
  const [loading,setLoading] = useState(false);
  const [version,setVersion] = useState("current release");
  const [release,setRelease] = useState<ReleaseNote | null>(null);
  const [markdown,setMarkdown] = useState<ReleaseMarkdown | null>(null);

  const show = async () => {
    setError(null);
    setLoading(true);
    setOpen(true);
    try {
      const [versionResponse,changelogResponse,platformConfigResponse] = await Promise.all([
        fetch("/api/version"),
        fetch("/api/changelog"),
        fetch("/api/admin/platform-config"),
      ]);
      const versionPayload = versionResponse.ok ? await versionResponse.json() : null;
      const nextVersion =
        normalizeVersion(versionPayload?.version) ??
        normalizeVersion(versionPayload?.packageVersion) ??
        "current release";
      setVersion(nextVersion);

      const changelogPayload = changelogResponse.ok ? await changelogResponse.json() : null;
      const platformConfigPayload = platformConfigResponse.ok
        ? await platformConfigResponse.json()
        : null;
      const releaseNotesConfig: Partial<ReleaseNotesNotificationConfig> =
        platformConfigPayload?.data?.release_notes ?? {};
      const customCompareConfigured = hasConfiguredReleaseNotesCompare(releaseNotesConfig) || hasReleaseNotesOverride(releaseNotesConfig, nextVersion);
      const match: ReleaseNote | null = customCompareConfigured
        ? null
        : changelogPayload?.releases?.find(
            (item: ReleaseNote) => normalizeVersion(item.version) === nextVersion,
          ) ?? null;
      setRelease(match);

      if (match) {
        setMarkdown(null);
      } else {
        const notesResponse = await fetch(
          releaseNotesRequestUrl(nextVersion, releaseNotesConfig),
        );
        const notesPayload = await notesResponse.json();
        if (!notesResponse.ok) {
          setRelease(null); setMarkdown(null);
          throw new Error(notesPayload?.error || "Release notes could not be loaded.");
        }
        const exactMatch =
          Boolean(notesPayload?.body) &&
          (customCompareConfigured ||
            normalizeVersion(notesPayload?.matchedVersion) === normalizeVersion(nextVersion) ||
            normalizeVersion(notesPayload?.matchedVersion) === baseVersion(nextVersion));
        setMarkdown(exactMatch ? {
          matchedVersion: notesPayload.matchedVersion ?? null,
          title: notesPayload.title ?? null,
          date: notesPayload.date ?? null,
          body: notesPayload.body,
          source: notesPayload.source,
          markdownBaseUrl: notesPayload.markdownBaseUrl,
          changelogUrl: notesPayload.changelogUrl ?? null,
        } : null);
      }
    } catch (error) {
      console.warn("[release-notes] Preview content could not be loaded",error);
      setError(error instanceof Error ? error.message : "Release notes could not be loaded.");
      setOpen(false);
      setRelease(null);
      setMarkdown(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button
        className="gap-2"
        disabled={loading}
        onClick={() => void show()}
        size="sm"
        type="button"
        variant="outline"
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
        Show current release notes
      </Button>
      {error && <p role="alert" className="text-sm text-destructive">{error} No override content is displayed. Login remains available.</p>}
      <ReleaseUpgradeDialog
        isAdmin={isAdmin}
        onDismissPermanently={() => setOpen(false)}
        onSkipUntilNextLogin={() => setOpen(false)}
        open={open}
        release={release}
        releaseMarkdown={markdown}
        releaseVersion={version}
      />
    </>
  );
}
