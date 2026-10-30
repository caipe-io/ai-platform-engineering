"use client";

import { ReleaseNotesPreview } from "@/components/settings/ReleaseNotesPreview";
import { NotificationDeliverySettings, type NotificationSettingsTab } from "@/components/settings/sections/NotificationDeliverySettings";
import { AutoSaveStatus } from "@/components/settings/shared/AutoSaveStatus";
import { SettingsCard } from "@/components/settings/shared/SettingsCard";
import { SettingsSwitch } from "@/components/settings/shared/SettingsSwitch";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAdminRole } from "@/hooks/use-admin-role";
import { useKeyedAutoSave } from "@/hooks/use-keyed-auto-save";
import {
  cacheAgentCompletionPreferences,
  deliverAgentCompletionAlert,
  getBrowserNotificationCapability,
  playCompletionChime,
  prepareBrowserNotificationDelivery,
  primeCompletionChime,
  requestBrowserNotificationPermission,
  type BrowserNotificationCapability,
} from "@/lib/agent-completion-notifications";
import { Activity,Bell,BellRing,ChevronsDownUp,ChevronsUpDown,Loader2,Volume2 } from "lucide-react";
import { useCallback,useEffect,useRef,useState } from "react";

type NotificationKey = "release-notes" | "browser-completions" | "completion-chime" | "platform-health";
type NotificationSection = "agent-completions" | "release-notes" | "platform-health" | `delivery:${string}`;

const NOTIFICATION_SECTIONS: NotificationSection[] = ["agent-completions","release-notes","platform-health"];

interface NotificationPreferences {
  browserEnabled: boolean;
  chimeEnabled: boolean;
  platformHealthEnabled: boolean;
  releaseNotesEnabled: boolean;
}

async function persistNotificationPreference(key: NotificationKey,value: boolean): Promise<void> {
  const isReleaseNotes = key === "release-notes";
  const response = await fetch(
    isReleaseNotes ? "/api/settings/preferences" : "/api/settings/notifications",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        isReleaseNotes
          ? { releaseNotesNotificationsEnabled: value }
          : key === "browser-completions"
            ? { agent_completion_browser_enabled: value }
            : key === "completion-chime"
              ? { agent_completion_chime_enabled: value }
              : { platform_health: value },
      ),
    },
  );
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.error || "Could not save the notification preference");
  }
}

function permissionDescription(capability: BrowserNotificationCapability): string {
  switch (capability) {
    case "granted":
      return "Allowed by this browser. Alerts appear only when CAIPE is hidden or unfocused.";
    case "denied":
      return "Blocked by this browser. Allow notifications for this site in browser settings to enable alerts.";
    case "unsupported":
      return "This browser does not support desktop notifications.";
    default:
      return "Your browser will ask for permission when you turn this on.";
  }
}

export function NotificationsSettings(): React.ReactElement {
  const { isAdmin } = useAdminRole();
  const [tab, setTab] = useState<NotificationSettingsTab>("delivery");
  const [deliverySections, setDeliverySections] = useState<NotificationSection[]>([]);
  const knownDeliverySections = useRef(new Set<string>());
  const visibleSections: NotificationSection[] = tab === "delivery"
    ? ["agent-completions", "delivery:channels"]
    : tab === "platform"
      ? ["release-notes", ...(isAdmin ? ["platform-health" as const] : []), "delivery:platform"]
      : tab === "status"
        ? ["delivery:status"]
        : deliverySections.filter((section) => section.startsWith("delivery:app:"));
  const [preferences,setPreferences] = useState<NotificationPreferences>({
    browserEnabled: false,
    chimeEnabled: false,
    platformHealthEnabled: true,
    releaseNotesEnabled: true,
  });
  const [capability,setCapability] = useState<BrowserNotificationCapability>(() => (
    getBrowserNotificationCapability()
  ));
  const [loading,setLoading] = useState(true);
  const [loadError,setLoadError] = useState<string | null>(null);
  const [testMessage,setTestMessage] = useState<string | null>(null);
  const [chimeTestMessage, setChimeTestMessage] = useState<string | null>(null);
  const [expandedSections,setExpandedSections] = useState<Set<NotificationSection>>(
    () => new Set(NOTIFICATION_SECTIONS),
  );
  const committedRef = useRef(preferences);

  const cacheCompletionPreferences = (next: NotificationPreferences): void => {
    cacheAgentCompletionPreferences({
      browserEnabled: next.browserEnabled,
      chimeEnabled: next.chimeEnabled,
    });
  };

  const autoSave = useKeyedAutoSave<NotificationKey,boolean>({
    persist: persistNotificationPreference,
    onSuccess: (key,value) => {
      const next = {
        ...committedRef.current,
        ...(key === "release-notes" ? { releaseNotesEnabled: value } : {}),
        ...(key === "browser-completions" ? { browserEnabled: value } : {}),
        ...(key === "completion-chime" ? { chimeEnabled: value } : {}),
        ...(key === "platform-health" ? { platformHealthEnabled: value } : {}),
      };
      committedRef.current = next;
      cacheCompletionPreferences(next);
      if (key === "platform-health") {
        window.dispatchEvent(new CustomEvent("in-app-notifications:refresh"));
      }
    },
    onError: (key) => {
      setPreferences((current) => {
        const next = {
          ...current,
          ...(key === "release-notes"
            ? { releaseNotesEnabled: committedRef.current.releaseNotesEnabled }
            : {}),
          ...(key === "browser-completions"
            ? { browserEnabled: committedRef.current.browserEnabled }
            : {}),
          ...(key === "completion-chime"
            ? { chimeEnabled: committedRef.current.chimeEnabled }
            : {}),
          ...(key === "platform-health"
            ? { platformHealthEnabled: committedRef.current.platformHealthEnabled }
            : {}),
        };
        cacheCompletionPreferences(next);
        return next;
      });
    },
  });

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/settings")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || "Could not load notification preferences");
        }
        if (cancelled) return;
        const next = {
          browserEnabled: data.data?.notifications?.agent_completion_browser_enabled === true,
          chimeEnabled: data.data?.notifications?.agent_completion_chime_enabled === true,
          platformHealthEnabled: data.data?.notifications?.platform_health !== false,
          releaseNotesEnabled: data.data?.preferences?.releaseNotesNotificationsEnabled !== false,
        };
        committedRef.current = next;
        setPreferences(next);
        cacheCompletionPreferences(next);
        setCapability(getBrowserNotificationCapability());
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setLoadError(reason instanceof Error ? reason.message : "Could not load notification preferences");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setPreference = (key: NotificationKey,value: boolean): void => {
    setPreferences((current) => {
      const next = {
        ...current,
        ...(key === "release-notes" ? { releaseNotesEnabled: value } : {}),
        ...(key === "browser-completions" ? { browserEnabled: value } : {}),
        ...(key === "completion-chime" ? { chimeEnabled: value } : {}),
        ...(key === "platform-health" ? { platformHealthEnabled: value } : {}),
      };
      cacheCompletionPreferences(next);
      return next;
    });
    autoSave.enqueue(key,value);
  };

  const changeBrowserNotifications = async (value: boolean): Promise<void> => {
    setTestMessage(null);
    if (!value) {
      setPreference("browser-completions",false);
      return;
    }

    const permission = await requestBrowserNotificationPermission();
    setCapability(permission);
    if (permission !== "granted") return;
    await prepareBrowserNotificationDelivery();
    setPreference("browser-completions",true);
  };

  const changeCompletionChime = (value: boolean): void => {
    setTestMessage(null);
    setChimeTestMessage(null);
    if (value) void primeCompletionChime();
    setPreference("completion-chime",value);
  };

  const testCompletionAlert = async (): Promise<void> => {
    setTestMessage("Sending test alert…");
    let currentCapability = getBrowserNotificationCapability();
    if (preferences.browserEnabled && currentCapability === "default") {
      currentCapability = await requestBrowserNotificationPermission();
      setCapability(currentCapability);
    }
    const result = await deliverAgentCompletionAlert(
      {
        agentName: "Example agent",
        conversationId: "example",
        href: "/settings/notifications",
        messageId: `test-${Date.now()}`,
      },
      {
        force: true,
        preferences: {
          browserEnabled: preferences.browserEnabled,
          chimeEnabled: preferences.chimeEnabled,
        },
      },
    );
    if (result.notificationShown && result.chimePlayed) {
      setTestMessage("Browser notification accepted and chime played. If no banner appeared, check system notifications for this browser.");
    } else if (result.notificationShown) {
      setTestMessage("Browser notification accepted. If no banner appeared, check system notifications for this browser.");
    } else if (result.chimePlayed && preferences.browserEnabled) {
      setTestMessage("Chime played, but the browser notification could not be shown. Check this site's notification permission.");
    } else if (result.chimePlayed) {
      setTestMessage("Chime played. Browser notifications are turned off.");
    } else if (preferences.browserEnabled && currentCapability !== "granted") {
      setTestMessage(permissionDescription(currentCapability));
    } else {
      setTestMessage("The browser blocked the test alert. Check this site's notification and audio permissions.");
    }
  };

  const retry = (key: NotificationKey): void => {
    const pendingValue = autoSave.pendingValueFor(key);
    if (pendingValue !== undefined) {
      setPreferences((current) => ({
        ...current,
        ...(key === "release-notes" ? { releaseNotesEnabled: pendingValue } : {}),
        ...(key === "browser-completions" ? { browserEnabled: pendingValue } : {}),
        ...(key === "completion-chime" ? { chimeEnabled: pendingValue } : {}),
        ...(key === "platform-health" ? { platformHealthEnabled: pendingValue } : {}),
      }));
    }
    autoSave.retry(key);
  };
  const onDeliverySectionsLoaded = useCallback((ids: string[]) => {
    setDeliverySections(ids as NotificationSection[]);
    const added = ids.filter((id) => !knownDeliverySections.current.has(id));
    added.forEach((id) => knownDeliverySections.current.add(id));
    if (added.length) setExpandedSections((current) => new Set([...current, ...added as NotificationSection[]]));
  }, [setExpandedSections]);
  const setSectionExpanded = (section: NotificationSection,expanded: boolean): void => {
    setExpandedSections((current) => {
      const next = new Set(current);
      if (expanded) next.add(section);
      else next.delete(section);
      return next;
    });
  };
  const expandedVisibleSections = visibleSections.filter((section) => expandedSections.has(section));
  const allExpanded = expandedVisibleSections.length === visibleSections.length;
  const allCollapsed = expandedVisibleSections.length === 0;

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading notification preferences…
      </div>
    );
  }

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as NotificationSettingsTab)} className="space-y-6">
      <div className="overflow-x-auto pb-1">
        <TabsList aria-label="Notification settings" className="w-max">
          <TabsTrigger value="delivery">Notification delivery</TabsTrigger>
          <TabsTrigger value="apps">Apps</TabsTrigger>
          <TabsTrigger value="platform">Platform</TabsTrigger>
          <TabsTrigger value="status">Delivery status</TabsTrigger>
        </TabsList>
      </div>
      {loadError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {loadError}
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button
          disabled={allExpanded}
          onClick={() => setExpandedSections((current) => new Set([...current,...visibleSections]))}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ChevronsUpDown className="mr-2 h-4 w-4" />Expand all
        </Button>
        <Button
          disabled={allCollapsed}
          onClick={() => setExpandedSections((current) => {
            const next = new Set(current);
            visibleSections.forEach((section) => next.delete(section));
            return next;
          })}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ChevronsDownUp className="mr-2 h-4 w-4" />Collapse all
        </Button>
      </div>

      <TabsContent value={tab} className="space-y-6">
      <NotificationDeliverySettings
        section={tab}
        expandedSections={expandedSections}
        onSectionChange={(id, expanded) => setSectionExpanded(id as NotificationSection, expanded)}
        onSectionsLoaded={onDeliverySectionsLoaded}
        chimeOption={
          <div role="group" aria-label="Chime delivery" className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Chime</p>
              <p className="text-xs text-muted-foreground">Play a short sound when a background agent turn finishes while the app is open.</p>
              <AutoSaveStatus className="mt-1" onRetry={() => retry("completion-chime")} state={autoSave.stateFor("completion-chime")} />
              {chimeTestMessage && <p role="status" className="mt-1 text-xs text-muted-foreground">{chimeTestMessage}</p>}
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={!preferences.chimeEnabled}
              onClick={() => {
                void playCompletionChime().then((played) => setChimeTestMessage(played
                  ? "Chime played."
                  : "The browser could not play the chime. Check this site's audio permissions."))
                  .catch(() => setChimeTestMessage("The browser could not play the chime. Check this site's audio permissions."));
              }}
            >
              <Volume2 className="mr-1 h-3 w-3" />Test chime
            </Button>
            <SettingsSwitch checked={preferences.chimeEnabled} label="Enable chime" onCheckedChange={changeCompletionChime} testId="agent-completion-chime-toggle" />
          </div>
        }
      />

      {tab === "delivery" && <SettingsCard
        collapsibleLabel="Agent completions"
        description="Get a quiet signal when a background agent turn finishes. No message content is included in the desktop alert."
        expanded={expandedSections.has("agent-completions")}
        onExpandedChange={(expanded) => setSectionExpanded("agent-completions",expanded)}
        title={<span className="flex items-center gap-2"><BellRing className="h-5 w-5 text-primary" />Agent completions</span>}
      >
        <div className="space-y-3">
          <div className="flex items-center gap-4 rounded-lg border border-border/70 p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Browser notifications</p>
              <p className="text-xs text-muted-foreground">{permissionDescription(capability)}</p>
              <AutoSaveStatus
                className="mt-1"
                onRetry={() => retry("browser-completions")}
                state={autoSave.stateFor("browser-completions")}
              />
            </div>
            <SettingsSwitch
              checked={preferences.browserEnabled}
              disabled={capability === "unsupported"}
              label="Browser notifications for agent completions"
              onCheckedChange={(value) => { void changeBrowserNotifications(value); }}
              testId="agent-completion-browser-toggle"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={!preferences.browserEnabled && !preferences.chimeEnabled}
              onClick={() => { void testCompletionAlert(); }}
              size="sm"
              type="button"
              variant="secondary"
            >
              <BellRing className="mr-2 h-4 w-4" />
              Send test alert
            </Button>
            {testMessage ? <p aria-live="polite" className="text-xs text-muted-foreground">{testMessage}</p> : null}
          </div>

          <p className="text-xs text-muted-foreground">
            Alerts work while a CAIPE tab remains open. They are independent of the selected agent harness.
          </p>
        </div>
      </SettingsCard>}

      {tab === "platform" && <SettingsCard
        collapsibleLabel="Release notes"
        description="Choose whether CAIPE announces a new release after you sign in."
        expanded={expandedSections.has("release-notes")}
        onExpandedChange={(expanded) => setSectionExpanded("release-notes",expanded)}
        title={<span className="flex items-center gap-2"><Bell className="h-5 w-5 text-primary" />Release notes</span>}
      >
        <div className="space-y-4">
          <div className="flex items-center gap-4 rounded-lg border border-border/70 p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Notify me about new releases</p>
              <p className="text-xs text-muted-foreground">
                Turning this off hides the release-notes dialog at login. You can still open it here.
              </p>
              <AutoSaveStatus
                className="mt-1"
                onRetry={() => retry("release-notes")}
                state={autoSave.stateFor("release-notes")}
              />
            </div>
            <SettingsSwitch
              checked={preferences.releaseNotesEnabled}
              label="Notify me about new releases"
              onCheckedChange={(value) => setPreference("release-notes",value)}
              testId="release-notes-user-pref-toggle"
            />
          </div>
          <ReleaseNotesPreview isAdmin={false} />
        </div>
      </SettingsCard>}
      {tab === "platform" && isAdmin ? <SettingsCard
        collapsibleLabel="Platform health"
        description="Choose whether global platform incidents appear in your personal notification feed."
        expanded={expandedSections.has("platform-health")}
        onExpandedChange={(expanded) => setSectionExpanded("platform-health",expanded)}
        title={<span className="flex items-center gap-2"><Activity className="h-5 w-5 text-primary" />Platform health</span>}
      >
        <div className="flex items-center gap-4 rounded-lg border border-border/70 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Notify me about platform health</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Show verified service degradations and recoveries in your notification bell. Turning this off only hides Platform messages for you; health monitoring and the global incident lifecycle continue unchanged.
            </p>
            <AutoSaveStatus
              className="mt-1"
              onRetry={() => retry("platform-health")}
              state={autoSave.stateFor("platform-health")}
            />
          </div>
          <SettingsSwitch
            checked={preferences.platformHealthEnabled}
            label="Notify me about platform health"
            onCheckedChange={(value) => setPreference("platform-health",value)}
            testId="platform-health-user-pref-toggle"
          />
        </div>
      </SettingsCard> : null}
      </TabsContent>
    </Tabs>
  );
}
