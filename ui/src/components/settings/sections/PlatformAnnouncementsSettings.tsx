"use client";

import { AutoSaveStatus } from "@/components/settings/shared/AutoSaveStatus";
import { SettingsCard } from "@/components/settings/shared/SettingsCard";
import { SettingsSwitch } from "@/components/settings/shared/SettingsSwitch";
import { useKeyedAutoSave } from "@/hooks/use-keyed-auto-save";
import { Loader2,Megaphone } from "lucide-react";
import { useEffect,useRef,useState } from "react";

type PlatformAnnouncementKey = "release-notes";

async function persistPlatformAnnouncement(
  _: PlatformAnnouncementKey,
  value: boolean,
): Promise<void> {
  const response = await fetch("/api/admin/platform-config",{
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ release_notes: { enabled: value } }),
  });
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.error || "Could not update platform announcements");
  }
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
        const value = data.data?.release_notes?.enabled !== false;
        committedRef.current = value;
        setEnabled(value);
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
        <div className="space-y-3">
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
              disabled={readOnly}
              label="Enable release announcements for the platform"
              onCheckedChange={change}
              testId="release-notes-platform-toggle"
            />
          </div>
        </div>
      )}
    </SettingsCard>
  );
}
