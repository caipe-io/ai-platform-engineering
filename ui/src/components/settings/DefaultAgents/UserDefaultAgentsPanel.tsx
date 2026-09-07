"use client";

import { AutoSaveStatus } from "@/components/settings/shared/AutoSaveStatus";
import { useAccessibleAgents } from "@/components/settings/DefaultAgents/useAccessibleAgents";
import { AgentPicker,type AgentPickerOption } from "@/components/ui/agent-picker";
import { useKeyedAutoSave,type AutoSaveState } from "@/hooks/use-keyed-auto-save";
import React,{ useCallback,useEffect,useRef,useState } from "react";

const PLATFORM_DEFAULT_KEY = "__platform_default__";
const WEBEX_ROW_PREFIX = "webex:";

type FlatSurface = "web" | "slack";
/** "web" | "slack" | "webex:<bot_id>" — one auto-save key per row shown. */
type RowKey = FlatSurface | `${typeof WEBEX_ROW_PREFIX}${string}`;

interface WebexBotSetting {
  agent_id: string | null;
  bot_id: string;
  bot_name: string;
  denied: boolean;
  editable: boolean;
}

interface PreferenceData {
  integrations?: { slack?: boolean; webex?: boolean };
  platform_default_agent_id?: string | null;
  slack_default_agent_id?: string | null;
  web_default_agent_id?: string | null;
  webex_bots?: WebexBotSetting[];
}

interface PreferenceResponse {
  data?: PreferenceData;
  error?: string;
  success?: boolean;
}

const FLAT_PREFERENCE_FIELDS: Record<FlatSurface,"slack_default_agent_id" | "web_default_agent_id"> = {
  web: "web_default_agent_id",
  slack: "slack_default_agent_id",
};

function webexRowKey(botId: string): RowKey {
  return `${WEBEX_ROW_PREFIX}${botId}`;
}

function webexBotIdFromRowKey(key: RowKey): string {
  return key.slice(WEBEX_ROW_PREFIX.length);
}

async function fetchSavedPreferences(): Promise<PreferenceData> {
  const response = await fetch("/api/user/preferences",{
    method: "GET",
    credentials: "same-origin",
  });
  const json = (await response.json()) as PreferenceResponse;
  if (!response.ok || !json.success) {
    throw new Error(
      typeof json.error === "string"
        ? json.error
        : `Failed to load preferences (HTTP ${response.status})`,
    );
  }
  return json.data ?? {};
}

async function persistPreference(key: RowKey,value: string): Promise<void> {
  const agentId = value === PLATFORM_DEFAULT_KEY ? null : value;
  const body =
    key === "web" || key === "slack"
      ? { [FLAT_PREFERENCE_FIELDS[key]]: agentId }
      : { webex_default_agent_id: { bot_id: webexBotIdFromRowKey(key),agent_id: agentId } };
  const response = await fetch("/api/user/preferences",{
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as PreferenceResponse;
  if (!response.ok || !json.success) {
    throw new Error(
      typeof json.error === "string"
        ? json.error
        : `Failed to save (HTTP ${response.status})`,
    );
  }
}

interface DefaultAgentSettingProps {
  agentDescription: string | null;
  ariaLabel: string;
  description: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onRetry: () => void;
  options: AgentPickerOption[];
  saveState: AutoSaveState;
  title: string;
  value: string;
}

function DefaultAgentSetting({
  agentDescription,
  ariaLabel,
  description,
  disabled,
  onChange,
  onRetry,
  options,
  saveState,
  title,
  value,
}: DefaultAgentSettingProps): React.ReactElement {
  return (
    <div className="space-y-3 rounded-lg border border-border/70 p-4">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <AgentPicker
        ariaLabel={ariaLabel}
        clearValue={PLATFORM_DEFAULT_KEY}
        disabled={disabled}
        emptyLabel="No agents match"
        hideIdSuffix
        onChange={onChange}
        options={options}
        placeholder="Select your default agent..."
        searchPlaceholder="Search agents..."
        triggerClassName="max-w-sm"
        value={value}
      />
      {agentDescription ? (
        <p className="text-xs text-muted-foreground">
          {`Agent description: ${agentDescription}`}
        </p>
      ) : null}
      <AutoSaveStatus onRetry={onRetry} state={saveState} />
    </div>
  );
}

interface ReadOnlyAgentSettingProps {
  agentName: string | null;
  caption: string;
  title: string;
}

function ReadOnlyAgentSetting({
  agentName,
  caption,
  title,
}: ReadOnlyAgentSettingProps): React.ReactElement {
  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-4">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{caption}</p>
      </div>
      <p className="text-sm">{agentName ?? "No agent configured"}</p>
    </div>
  );
}

interface UserDefaultAgentsPanelProps {
  /** Suppress writes, for example while an admin previews another user. */
  disabled?: boolean;
}

export function UserDefaultAgentsPanel({
  disabled = false,
}: UserDefaultAgentsPanelProps): React.ReactElement {
  const {
    agents,
    error: agentsError,
    loading: agentsLoading,
    refresh: refreshAgents,
  } = useAccessibleAgents();
  const [selected,setSelected] = useState<Partial<Record<RowKey,string>>>({
    web: PLATFORM_DEFAULT_KEY,
    slack: PLATFORM_DEFAULT_KEY,
  });
  const savedRef = useRef<Partial<Record<RowKey,string>>>({});
  const [integrations,setIntegrations] = useState({ slack: false,webex: false });
  const [webexBots,setWebexBots] = useState<WebexBotSetting[]>([]);
  const [preferenceLoading,setPreferenceLoading] = useState(true);
  const [platformDefaultId,setPlatformDefaultId] = useState<string | null>(null);
  const [loadError,setLoadError] = useState<string | null>(null);

  const autoSave = useKeyedAutoSave<RowKey,string>({
    persist: persistPreference,
    onSuccess: (key,value) => {
      savedRef.current = { ...savedRef.current,[key]: value };
    },
    onError: (key) => {
      setSelected((current) => ({
        ...current,
        [key]: savedRef.current[key],
      }));
    },
  });

  useEffect(() => {
    let cancelled = false;
    void fetchSavedPreferences()
      .then((data) => {
        if (cancelled) return;
        const bots = data.webex_bots ?? [];
        const loaded: Partial<Record<RowKey,string>> = {
          web: data.web_default_agent_id ?? PLATFORM_DEFAULT_KEY,
          slack: data.slack_default_agent_id ?? PLATFORM_DEFAULT_KEY,
        };
        for (const bot of bots) {
          if (bot.editable) {
            loaded[webexRowKey(bot.bot_id)] = bot.agent_id ?? PLATFORM_DEFAULT_KEY;
          }
        }
        savedRef.current = loaded;
        setSelected(loaded);
        setIntegrations({
          slack: data.integrations?.slack === true,
          webex: data.integrations?.webex === true,
        });
        setWebexBots(bots);
        setPlatformDefaultId(data.platform_default_agent_id ?? null);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setLoadError(reason instanceof Error ? reason.message : "Failed to load preferences");
        }
      })
      .finally(() => {
        if (!cancelled) setPreferenceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelect = useCallback((key: RowKey,value: string) => {
    if (disabled || selected[key] === value) return;
    setSelected((current) => ({ ...current,[key]: value }));
    autoSave.enqueue(key,value);
  }, [autoSave,disabled,selected]);

  const loading = agentsLoading || preferenceLoading;
  const agentOptions: AgentPickerOption[] = agents.map((agent) => ({
    value: agent.id,
    label: agent.name,
  }));
  const agentName = (agentId: string | null): string | null =>
    agentId ? agents.find((agent) => agent.id === agentId)?.name ?? agentId : null;
  const agentDescription = (agentId: string | null): string | null =>
    agentId ? agents.find((agent) => agent.id === agentId)?.description ?? null : null;
  const platformDefaultName = agentName(platformDefaultId);
  const defaultOptions: AgentPickerOption[] = [
    {
      value: PLATFORM_DEFAULT_KEY,
      label: platformDefaultName
        ? `Use platform default (${platformDefaultName})`
        : "Use platform default",
    },
    ...agentOptions,
  ];
  const selectedAgentId = (key: RowKey): string | null => {
    const value = selected[key];
    return value === undefined || value === PLATFORM_DEFAULT_KEY ? platformDefaultId : value;
  };
  const retryRow = (key: RowKey) => {
    const pendingValue = autoSave.pendingValueFor(key);
    if (pendingValue !== undefined) {
      setSelected((current) => ({ ...current,[key]: pendingValue }));
    }
    autoSave.retry(key);
  };

  if (agentsError || loadError) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
        <p>Failed to load defaults: {agentsError ?? loadError}</p>
        {agentsError ? (
          <button
            className="mt-2 rounded border border-input bg-background px-2 py-1 text-xs"
            onClick={() => void refreshAgents()}
            type="button"
          >
            Retry
          </button>
        ) : null}
      </div>
    );
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading default agents…</p>;
  }

  return (
    <div className="space-y-4">
      {agents.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No agents are currently available to you. You can still follow the platform default.
        </p>
      ) : null}

      <DefaultAgentSetting
        agentDescription={agentDescription(selectedAgentId("web"))}
        ariaLabel="Web default agent"
        description="Choose the agent your new Web chats open with."
        disabled={disabled}
        onChange={(value) => handleSelect("web",value)}
        onRetry={() => retryRow("web")}
        options={defaultOptions}
        saveState={autoSave.stateFor("web")}
        title="Web default agent"
        value={selected.web ?? PLATFORM_DEFAULT_KEY}
      />

      {integrations.slack ? (
        <DefaultAgentSetting
          agentDescription={agentDescription(selectedAgentId("slack"))}
          ariaLabel="Slack default agent"
          description="Choose the agent your new Slack direct messages open with."
          disabled={disabled}
          onChange={(value) => handleSelect("slack",value)}
          onRetry={() => retryRow("slack")}
          options={defaultOptions}
          saveState={autoSave.stateFor("slack")}
          title="Slack default agent"
          value={selected.slack ?? PLATFORM_DEFAULT_KEY}
        />
      ) : null}

      {webexBots.map((bot) => {
        const key = webexRowKey(bot.bot_id);
        const title = webexBots.length > 1 ? `Webex default agent — ${bot.bot_name}` : "Webex default agent";

        if (!bot.editable) {
          return (
            <ReadOnlyAgentSetting
              agentName={agentName(bot.agent_id)}
              caption={
                bot.denied
                  ? `An admin has disabled direct messages for you on ${bot.bot_name}.`
                  : `An admin manages your default agent for ${bot.bot_name} in the 1:1 Messages settings.`
              }
              key={bot.bot_id}
              title={title}
            />
          );
        }

        return (
          <DefaultAgentSetting
            agentDescription={agentDescription(selectedAgentId(key))}
            ariaLabel={title}
            description={`Choose the agent your new Webex direct messages with ${bot.bot_name} open with.`}
            disabled={disabled}
            key={bot.bot_id}
            onChange={(value) => handleSelect(key,value)}
            onRetry={() => retryRow(key)}
            options={defaultOptions}
            saveState={autoSave.stateFor(key)}
            title={title}
            value={selected[key] ?? PLATFORM_DEFAULT_KEY}
          />
        );
      })}
    </div>
  );
}
