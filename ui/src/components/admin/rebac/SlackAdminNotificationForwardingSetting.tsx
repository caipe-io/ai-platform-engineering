"use client";

// Superadmin-only setting on Admin → Integrations → Slack → Advanced.
// When a notification would go to a platform admin (approvals, platform
// health alerts), also posts it to a Slack channel with the configured
// users pinged, in addition to it still appearing in the CAIPE notification
// bell. Persisted in platform_config (slack_admin_notification_forwarding).

import { Bell,Loader2 } from "lucide-react";
import { useEffect,useState } from "react";

import { SaveButton } from "@/components/admin/shared/SaveButton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import type { AdminNotificationForwardingConfig } from "@/types/admin-notification-forwarding";

import { SlackUserTokenInput } from "./slack/SlackUserTokenInput";

interface ChannelOption {
  id: string;
  name: string;
}

function sortedEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

export function SlackAdminNotificationForwardingSetting({ disabled = false }: { disabled?: boolean }) {
  const { toast } = useToast();

  const [enabled, setEnabled] = useState(false);
  const [savedEnabled, setSavedEnabled] = useState(false);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [channelName, setChannelName] = useState<string | null>(null);
  const [savedChannelId, setSavedChannelId] = useState<string | null>(null);
  const [pingUserIds, setPingUserIds] = useState<string[]>([]);
  const [savedPingUserIds, setSavedPingUserIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [channelQuery, setChannelQuery] = useState("");
  const [channelOptions, setChannelOptions] = useState<ChannelOption[]>([]);
  const [channelPickerLoading, setChannelPickerLoading] = useState(false);
  const [channelDiscoveryUnavailable, setChannelDiscoveryUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/slack/admin-notification-forwarding");
        const data = await res.json().catch(() => ({ success: false }));
        if (cancelled) return;
        if (data?.success && data.data) {
          const cfg = data.data as AdminNotificationForwardingConfig;
          setEnabled(Boolean(cfg.enabled));
          setSavedEnabled(Boolean(cfg.enabled));
          setChannelId(cfg.channel_id ?? null);
          setChannelName(cfg.channel_name ?? null);
          setSavedChannelId(cfg.channel_id ?? null);
          setPingUserIds(cfg.ping_user_ids ?? []);
          setSavedPingUserIds(cfg.ping_user_ids ?? []);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (channelDiscoveryUnavailable) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setChannelPickerLoading(true);
      fetch(`/api/admin/slack/available-channels?q=${encodeURIComponent(channelQuery.trim())}`)
        .then(async (res) => {
          if (res.status === 503) {
            if (!cancelled) setChannelDiscoveryUnavailable(true);
            return null;
          }
          if (!res.ok) throw new Error("Slack channel discovery failed");
          return res.json();
        })
        .then((payload) => {
          if (cancelled || !payload) return;
          const channels = (payload?.data?.channels ?? []) as Array<{ id: string; name: string }>;
          setChannelOptions(channels.map((c) => ({ id: c.id, name: c.name })));
        })
        .catch(() => {
          if (!cancelled) setChannelOptions([]);
        })
        .finally(() => {
          if (!cancelled) setChannelPickerLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [channelQuery, channelDiscoveryUnavailable]);

  const dirty =
    enabled !== savedEnabled ||
    channelId !== savedChannelId ||
    !sortedEqual(pingUserIds, savedPingUserIds);

  const handleSave = async () => {
    if (enabled && !channelId) {
      toast("Select a Slack channel before enabling admin notification forwarding.", "error");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/slack/admin-notification-forwarding", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          channel_id: channelId,
          channel_name: channelName,
          ping_user_ids: pingUserIds,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data?.error || "Failed to save");
      setSavedEnabled(enabled);
      setSavedChannelId(channelId);
      setSavedPingUserIds(pingUserIds);
      toast("Admin notification forwarding saved.", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save admin notification forwarding", "error");
    } finally {
      setSaving(false);
    }
  };

  const selectedChannelOption: ChannelOption | undefined = channelId
    ? { id: channelId, name: channelName || channelId }
    : undefined;
  const pickerOptions: ChannelOption[] = selectedChannelOption &&
    !channelOptions.some((option) => option.id === selectedChannelOption.id)
    ? [selectedChannelOption, ...channelOptions]
    : channelOptions;

  const controlsDisabled = disabled || saving;

  return (
    <div className="rounded-md border bg-background/50 p-3 space-y-3">
      <div>
        <h3 className="inline-flex items-center gap-2 text-base font-semibold tracking-tight">
          <Bell className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Forward Platform Admin Notifications
        </h3>
        <p className="text-xs text-muted-foreground">
          When a notification would go to a platform admin (approvals, platform alerts), also post it
          to a Slack channel with the people below pinged and a link back into CAIPE. The notification
          still appears in CAIPE either way.
        </p>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Switch
              id="slack-admin-notification-forwarding-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={disabled || saving}
              aria-label="Enable forwarding platform admin notifications to Slack"
            />
            <Label htmlFor="slack-admin-notification-forwarding-enabled">Enabled</Label>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="slack-admin-notification-forwarding-channel">Channel</Label>
            {channelDiscoveryUnavailable ? (
              <>
                <Input
                  id="slack-admin-notification-forwarding-channel"
                  value={channelId ?? ""}
                  disabled={controlsDisabled}
                  placeholder="Paste a Slack channel ID (e.g. C0123456789)"
                  onChange={(event) => {
                    const next = event.target.value.trim();
                    setChannelId(next || null);
                    setChannelName(next || null);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Slack channel discovery is unavailable (the bot token is not configured on this
                  service). Paste the channel ID manually; the bot must still be a member of it.
                </p>
              </>
            ) : (
              <SearchablePicker<ChannelOption>
                id="slack-admin-notification-forwarding-channel"
                options={pickerOptions}
                selected={selectedChannelOption}
                onSelect={(option) => {
                  setChannelId(option.id);
                  setChannelName(option.name);
                }}
                onClear={() => {
                  setChannelId(null);
                  setChannelName(null);
                }}
                getOptionKey={(option) => option.id}
                getOptionLabel={(option) => `#${option.name}`}
                placeholder="Select a channel"
                searchPlaceholder="Search channels"
                emptyLabel="No channels found"
                disabled={controlsDisabled}
                ariaLabel="Slack channel to forward platform admin notifications to"
                loading={channelPickerLoading}
                loadingLabel="Loading channels..."
                searchValue={channelQuery}
                onSearchChange={setChannelQuery}
                filterOptions={false}
              />
            )}
          </div>

          <SlackUserTokenInput
            label="Users to ping"
            value={pingUserIds}
            onChange={setPingUserIds}
            disabled={controlsDisabled}
            placeholder="Search Slack users"
          />

          <div className="flex items-center gap-2">
            <SaveButton
              onSave={handleSave}
              saving={saving}
              dirty={dirty}
              disabled={disabled}
              ariaLabel="Save admin notification forwarding"
            />
          </div>
        </div>
      )}
    </div>
  );
}
