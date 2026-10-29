"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ReleaseUpgradeDialog } from "@/components/release/ReleaseUpgradeDialog";
import { MAX_RELEASE_NOTES_LENGTH, normalizeReleaseNotesOverride, validateReleaseNotesOverride, type ReleaseNotesOverride } from "@/lib/release-notes-override";

export function ReleaseNotesOverrideSettings({ readOnly = false }: { readOnly?: boolean }) {
  const [config, setConfig] = useState<ReleaseNotesOverride>(() => normalizeReleaseNotesOverride(null));
  const [saved, setSaved] = useState("");
  const [repositories, setRepositories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/admin/platform-config");
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error("Could not load curated notes.");
        if (cancelled) return;
        const next = normalizeReleaseNotesOverride(payload.data?.release_notes?.override);
        setConfig(next); setSaved(JSON.stringify(next));
        setRepositories(payload.data?.release_notes_allowed_repositories ?? []);
      } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load curated notes."); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);
  const update = (key: keyof ReleaseNotesOverride, value: string) => {
    setConfig((current) => ({ ...current, [key]: value })); setMessage("");
  };
  const save = async () => {
    const snapshot = normalizeReleaseNotesOverride(config);
    const invalid = validateReleaseNotesOverride(snapshot);
    if (invalid) { setError(invalid); return; }
    setSaving(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/admin/platform-config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ release_notes: { override: snapshot } }) });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || payload.error || "Could not save curated notes.");
      setSaved(JSON.stringify(snapshot)); setMessage("Curated notes saved. Use the current release preview below to check the published source.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save curated notes."); }
    finally { setSaving(false); }
  };
  return <div className="space-y-3 rounded-lg border p-4">
    <h3 className="text-sm font-medium">Curated release notes</h3>
    <p className="text-xs text-muted-foreground">Select an override for one deployed release. Automatic restores the existing comparison or deployed-version notes. Switching sources keeps inactive content for later editing.</p>
    <fieldset disabled={readOnly || loading || saving || !saved} className="space-y-3">
      <label className="block text-sm">Content source<Select value={config.source} onChange={(event) => update("source", event.target.value)}>
        <option value="automatic">Automatic</option><option value="manual">Enter Markdown</option><option value="repository">Repository Markdown</option>
      </Select></label>
      {config.source !== "automatic" && <label className="block text-sm">Deployed release version<Input value={config.release_version} onChange={(event) => update("release_version", event.target.value)} placeholder="1.3.2" /></label>}
      {config.source === "manual" && <>
        <label className="block text-sm">Release notes Markdown<Textarea value={config.markdown} maxLength={MAX_RELEASE_NOTES_LENGTH} rows={12} onChange={(event) => update("markdown", event.target.value)} /></label>
        <label className="block text-sm">Full changelog URL (optional)<Input value={config.changelog_url} onChange={(event) => update("changelog_url", event.target.value)} placeholder="https://example.com/releases" /></label>
        <Button type="button" variant="outline" onClick={() => setPreview(true)}>Preview entered Markdown</Button>
      </>}
      {config.source === "repository" && <>
        <label className="block text-sm">Markdown repository<Select value={config.markdown_repository} onChange={(event) => update("markdown_repository", event.target.value)}>
          <option value="">Choose an approved repository</option>
          {config.markdown_repository && !repositories.includes(config.markdown_repository) && <option value={config.markdown_repository} disabled>{config.markdown_repository} (not approved)</option>}
          {repositories.map((repository) => <option key={repository} value={repository}>{repository}</option>)}
        </Select></label>
        <label className="block text-sm">Markdown Git ref<Input value={config.markdown_ref} onChange={(event) => update("markdown_ref", event.target.value)} placeholder="v1.3.2" /></label>
        <label className="block text-sm">Markdown file path<Input value={config.markdown_path} onChange={(event) => update("markdown_path", event.target.value)} placeholder="docs/releases/release-1-3-2.md" /></label>
      </>}
      <Button type="button" disabled={JSON.stringify(config) === saved} onClick={() => void save()}>{saving ? "Saving…" : "Save curated notes"}</Button>
    </fieldset>
    {message && <p role="status" className="text-sm">{message}</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <ReleaseUpgradeDialog open={preview} isAdmin releaseVersion={config.release_version || "preview"} release={null} releaseMarkdown={{ matchedVersion: config.release_version, title: null, date: null, body: config.markdown, source: "manual", changelogUrl: config.changelog_url || null }} onSkipUntilNextLogin={() => setPreview(false)} onDismissPermanently={() => setPreview(false)} />
  </div>;
}
