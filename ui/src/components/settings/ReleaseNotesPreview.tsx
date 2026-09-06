"use client";

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
  const [open,setOpen] = useState(false);
  const [loading,setLoading] = useState(false);
  const [version,setVersion] = useState("current release");
  const [release,setRelease] = useState<ReleaseNote | null>(null);
  const [markdown,setMarkdown] = useState<ReleaseMarkdown | null>(null);

  const show = async () => {
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
      const customCompareConfigured = hasConfiguredReleaseNotesCompare(releaseNotesConfig);
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
        const notesPayload = notesResponse.ok ? await notesResponse.json() : null;
        const exactMatch =
          Boolean(notesPayload?.body) &&
          (customCompareConfigured ||
            normalizeVersion(notesPayload?.matchedVersion) === baseVersion(nextVersion));
        setMarkdown(exactMatch ? {
          matchedVersion: notesPayload.matchedVersion ?? null,
          title: notesPayload.title ?? null,
          date: notesPayload.date ?? null,
          body: notesPayload.body,
          changelogUrl: notesPayload.changelogUrl ?? null,
        } : null);
      }
    } catch (error) {
      console.warn("[release-notes] Preview content could not be loaded",error);
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
