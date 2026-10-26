"use client";

import { ReleaseNotesPreview } from "@/components/settings/ReleaseNotesPreview";
import { AutoSaveStatus } from "@/components/settings/shared/AutoSaveStatus";
import { SettingsCard } from "@/components/settings/shared/SettingsCard";
import { SettingsSwitch } from "@/components/settings/shared/SettingsSwitch";
import { SaveButton } from "@/components/admin/shared/SaveButton";
import { useKeyedAutoSave } from "@/hooks/use-keyed-auto-save";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { isValidReleaseNotesRef, parseReleaseNotesRepository } from "@/lib/release-notes-ref";
import { Loader2,Megaphone } from "lucide-react";
import { useEffect,useRef,useState } from "react";

type PlatformAnnouncementKey = "release-notes";

interface CompareFields {
  repositoryUrl: string;
  previousCommit: string;
  latestCommit: string;
}

function validateCompareFields(fields: CompareFields): string | null {
  const values = [fields.repositoryUrl.trim(),fields.previousCommit.trim(),fields.latestCommit.trim()];
  const configured = values.filter(Boolean).length;
  if (configured !== 0 && configured !== 3) {
    return "Set the repository URL and both commits, or leave all three empty.";
  }
  if (configured === 0) return null;

  if (!parseReleaseNotesRepository(values[0])) {
    return "Enter an https://github.com/<owner>/<repository> URL.";
  }

  if (!isValidReleaseNotesRef(values[1]) || !isValidReleaseNotesRef(values[2])) {
    return "Enter a valid commit SHA, tag, or branch name for each ref.";
  }
  return null;
}

export function PlatformAnnouncementsSettings({
  readOnly = false,
}: {
  readOnly?: boolean;
}): React.ReactElement {
  const [enabled,setEnabled] = useState(true);
  const [loading,setLoading] = useState(true);
  const [loadError,setLoadError] = useState<string | null>(null);
  const committedRef = useRef(true);

  const [repositoryUrl,setRepositoryUrl] = useState("");
  const [allowedRepositories,setAllowedRepositories] = useState<string[]>([]);
  const [savedRepositoryUrl,setSavedRepositoryUrl] = useState("");
  const [previousCommit,setPreviousCommit] = useState("");
  const [savedPreviousCommit,setSavedPreviousCommit] = useState("");
  const [latestCommit,setLatestCommit] = useState("");
  const [savedLatestCommit,setSavedLatestCommit] = useState("");
  const [savingConfig,setSavingConfig] = useState(false);
  const [configSaveResult,setConfigSaveResult] = useState<"success" | "error" | null>(null);
  const [configSaveError,setConfigSaveError] = useState<string | null>(null);
  const compareRef = useRef<CompareFields>({
    repositoryUrl: "",
    previousCommit: "",
    latestCommit: "",
  });

  const setCompareField = (field: keyof CompareFields,value: string): void => {
    compareRef.current[field] = value;
    const setters = {
      repositoryUrl: setRepositoryUrl,
      previousCommit: setPreviousCommit,
      latestCommit: setLatestCommit,
    } as const;
    setters[field](value);
  };

  const persistPlatformAnnouncement = async (
    _: PlatformAnnouncementKey,
    value: boolean,
  ): Promise<void> => {
    const response = await fetch("/api/admin/platform-config",{
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        release_notes: { enabled: value },
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || "Could not update platform announcements");
    }
  };

  const autoSave = useKeyedAutoSave<PlatformAnnouncementKey,boolean>({
    persist: persistPlatformAnnouncement,
    onSuccess: (_,value) => {
      committedRef.current = value;
    },
    onError: () => {
      setEnabled(committedRef.current);
    },
  });

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/admin/platform-config")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || "Could not load platform announcements");
        }
        if (cancelled) return;
        const config = data.data?.release_notes;
        setAllowedRepositories(data.data?.release_notes_allowed_repositories ?? []);
        const value = config?.enabled !== false;
        const nextCompare: CompareFields = {
          repositoryUrl: config?.repository_url?.trim() ?? "",
          previousCommit: config?.previous_commit?.trim() ?? "",
          latestCommit: config?.latest_commit?.trim() ?? "",
        };
        committedRef.current = value;
        compareRef.current = nextCompare;
        setEnabled(value);
        setRepositoryUrl(nextCompare.repositoryUrl);
        setSavedRepositoryUrl(nextCompare.repositoryUrl);
        setPreviousCommit(nextCompare.previousCommit);
        setSavedPreviousCommit(nextCompare.previousCommit);
        setLatestCommit(nextCompare.latestCommit);
        setSavedLatestCommit(nextCompare.latestCommit);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setLoadError(reason instanceof Error ? reason.message : "Could not load platform announcements");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const change = (value: boolean) => {
    setEnabled(value);
    autoSave.enqueue("release-notes",value);
  };

  const retry = () => {
    const pendingValue = autoSave.pendingValueFor("release-notes");
    if (pendingValue !== undefined) setEnabled(pendingValue);
    autoSave.retry("release-notes");
  };

  const saveCompareConfig = async (): Promise<void> => {
    if (readOnly || loading || loadError || savingConfig) return;
    const snapshot = { ...compareRef.current };
    const fields = {
      repositoryUrl: snapshot.repositoryUrl.trim(),
      previousCommit: snapshot.previousCommit.trim(),
      latestCommit: snapshot.latestCommit.trim(),
    };
    const validationError = validateCompareFields(fields) ||
      (fields.repositoryUrl && !allowedRepositories.includes(fields.repositoryUrl)
        ? "Choose a repository approved by the deployment configuration." : null);
    if (validationError) {
      setConfigSaveResult("error");
      setConfigSaveError(validationError);
      return;
    }

    setSavingConfig(true);
    setConfigSaveResult(null);
    setConfigSaveError(null);
    try {
      const response = await fetch("/api/admin/platform-config",{
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          release_notes: {
            repository_url: fields.repositoryUrl.trim() || null,
            previous_commit: fields.previousCommit.trim() || null,
            latest_commit: fields.latestCommit.trim() || null,
          },
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error?.message || data.error || "Could not save release notes configuration");
      }
      setSavedRepositoryUrl(snapshot.repositoryUrl);
      setSavedPreviousCommit(snapshot.previousCommit);
      setSavedLatestCommit(snapshot.latestCommit);
      setConfigSaveResult("success");
    } catch (reason) {
      setConfigSaveResult("error");
      setConfigSaveError(reason instanceof Error ? reason.message : "Could not save release notes configuration");
    } finally {
      setSavingConfig(false);
    }
  };

  const compareDirty =
    repositoryUrl !== savedRepositoryUrl ||
    previousCommit !== savedPreviousCommit ||
    latestCommit !== savedLatestCommit;

  return (
    <SettingsCard
      description="This platform setting affects the post-login release announcement for every user."
      title={<span className="flex items-center gap-2"><Megaphone className="h-5 w-5 text-primary" />Release announcements</span>}
    >
      {loading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading platform setting…
        </div>
      ) : (
        <div className="space-y-4">
          {loadError ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {loadError}
            </div>
          ) : null}
          <div className="flex items-center gap-4 rounded-lg border border-border/70 p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Enable release announcements</p>
              <p className="text-xs text-muted-foreground">
                When disabled, no user receives the automatic release-notes dialog after login.
              </p>
              <AutoSaveStatus
                className="mt-1"
                onRetry={retry}
                state={autoSave.stateFor("release-notes")}
              />
            </div>
            <SettingsSwitch
              checked={enabled}
              disabled={readOnly || Boolean(loadError)}
              label="Enable release announcements for the platform"
              onCheckedChange={change}
              testId="release-notes-platform-toggle"
            />
          </div>

          <div className="space-y-3 rounded-lg border border-border/70 p-4">
            <div>
              <p className="text-sm font-medium">Optional GitHub commit diff</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Set all three fields to show changes between two commits. This works for standard and non-standard release tags.
                Leave them empty to use the deployed-version release notes.
              </p>
            </div>
            <label className="block space-y-1 text-xs font-medium" htmlFor="release-notes-repository-url">
              <span>Repository URL</span>
              <Select
                id="release-notes-repository-url"
                aria-describedby="release-notes-repository-help"
                value={repositoryUrl}
                onChange={(event) => {
                  setCompareField("repositoryUrl",event.target.value);
                  if (!event.target.value) {
                    setCompareField("previousCommit","");
                    setCompareField("latestCommit","");
                  }
                }}
                disabled={readOnly}
              >
                <option value="">Use deployed-version release notes</option>
                {repositoryUrl && !allowedRepositories.includes(repositoryUrl) ? (
                  <option value={repositoryUrl} disabled>{repositoryUrl} (not approved)</option>
                ) : null}
                {allowedRepositories.map((repository) => (
                  <option key={repository} value={repository}>{repository}</option>
                ))}
              </Select>
            </label>
            <p id="release-notes-repository-help" className="text-xs text-muted-foreground">
              {allowedRepositories.length ? "Only repositories approved by your deployment are available." :
                "No repositories are approved for commit comparisons. Contact your deployment administrator."}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1 text-xs font-medium" htmlFor="release-notes-previous-commit">
                <span>Previous upgraded commit</span>
                <Input
                  id="release-notes-previous-commit"
                  value={previousCommit}
                  onChange={(event) => setCompareField("previousCommit",event.target.value)}
                  placeholder="Previous commit SHA"
                  disabled={readOnly}
                  spellCheck={false}
                />
              </label>
              <label className="block space-y-1 text-xs font-medium" htmlFor="release-notes-latest-commit">
                <span>Latest commit</span>
                <Input
                  id="release-notes-latest-commit"
                  value={latestCommit}
                  onChange={(event) => setCompareField("latestCommit",event.target.value)}
                  placeholder="Latest commit SHA"
                  disabled={readOnly}
                  spellCheck={false}
                />
              </label>
            </div>
            {configSaveError ? <p className="text-xs text-destructive" role="alert">{configSaveError}</p> : null}
            <SaveButton
              ariaLabel="Save release notes configuration"
              dirty={compareDirty}
              disabled={readOnly || Boolean(loadError)}
              onSave={() => void saveCompareConfig()}
              result={configSaveResult}
              saving={savingConfig}
            />
          </div>

          <ReleaseNotesPreview isAdmin />
        </div>
      )}
    </SettingsCard>
  );
}
