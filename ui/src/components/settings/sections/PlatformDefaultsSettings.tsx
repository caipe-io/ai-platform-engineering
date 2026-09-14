"use client";

import { AutoSaveStatus } from "@/components/settings/shared/AutoSaveStatus";
import { SettingsCard } from "@/components/settings/shared/SettingsCard";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AgentPicker,type AgentPickerOption } from "@/components/ui/agent-picker";
import type { AutoSaveState } from "@/hooks/use-keyed-auto-save";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import {
  AlertTriangle,
  Bot,
  CalendarClock,
  Loader2,
} from "lucide-react";
import { useEffect,useState } from "react";

type PendingAction = "set" | "clear";

export function PlatformDefaultsSettings({
  readOnly = false,
}: {
  readOnly?: boolean;
}): React.ReactElement {
  const [agents,setAgents] = useState<DynamicAgentConfig[]>([]);
  const [selectedAgentId,setSelectedAgentId] = useState<string | null>(null);
  const [savedAgentId,setSavedAgentId] = useState<string | null>(null);
  const [loading,setLoading] = useState(true);
  const [loadError,setLoadError] = useState<string | null>(null);
  const [saveState,setSaveState] = useState<AutoSaveState>({ status: "idle" });
  const [configSource,setConfigSource] = useState("fallback");
  const [selectedScheduleEditorAgentId,setSelectedScheduleEditorAgentId] = useState<string | null>(null);
  const [savedScheduleEditorAgentId,setSavedScheduleEditorAgentId] = useState<string | null>(null);
  const [scheduleEditorSource,setScheduleEditorSource] = useState("fallback");
  const [scheduleEditorSaveState,setScheduleEditorSaveState] = useState<AutoSaveState>({ status: "idle" });
  const [confirmAction,setConfirmAction] = useState<PendingAction | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Loading available agents first preserves the existing global-agent
        // reconciliation side effect before the configured default is read.
        const agentsResponse = await fetch("/api/dynamic-agents/available");
        const agentsData = await agentsResponse.json();
        if (!agentsResponse.ok) throw new Error(agentsData.error || "Could not load agents");
        if (cancelled) return;
        setAgents(agentsData.data || []);

        const configResponse = await fetch("/api/admin/platform-config");
        const configData = await configResponse.json();
        if (!configResponse.ok || !configData.success) {
          throw new Error(configData.error || "Could not load the platform default");
        }
        if (cancelled) return;
        const value = configData.data.default_agent_id ?? null;
        setSelectedAgentId(value);
        setSavedAgentId(value);
        setConfigSource(configData.data.source || "fallback");
        const scheduleEditorValue = configData.data.schedule_editor_agent_id ?? null;
        setSelectedScheduleEditorAgentId(scheduleEditorValue);
        setSavedScheduleEditorAgentId(scheduleEditorValue);
        setScheduleEditorSource(configData.data.schedule_editor_agent_source || "fallback");
      } catch (reason) {
        if (!cancelled) {
          setLoadError(reason instanceof Error ? reason.message : "Could not load the platform default");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectAgent = (value: string) => {
    const next = value || null;
    if (next === savedAgentId) {
      setSelectedAgentId(savedAgentId);
      return;
    }
    setSelectedAgentId(next);
    setSaveState({ status: "idle" });
    setConfirmAction(next === null ? "clear" : "set");
  };

  const cancel = () => {
    if (saveState.status === "saving") return;
    setSelectedAgentId(savedAgentId);
    setConfirmAction(null);
  };

  const confirm = async () => {
    setSaveState({ status: "saving" });
    try {
      const response = await fetch("/api/admin/platform-config",{
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          default_agent_id: selectedAgentId,
          acknowledge_public_access: true,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || "Could not update the platform default");
      }
      setSavedAgentId(selectedAgentId);
      setConfigSource("db");
      setSaveState({ status: "saved" });
    } catch (reason) {
      setSelectedAgentId(savedAgentId);
      setSaveState({
        status: "error",
        error: reason instanceof Error ? reason.message : "Could not update the platform default",
      });
    } finally {
      setConfirmAction(null);
    }
  };

  const selectScheduleEditorAgent = async (value: string) => {
    const next = value || null;
    if (next === savedScheduleEditorAgentId) {
      setSelectedScheduleEditorAgentId(savedScheduleEditorAgentId);
      return;
    }

    setSelectedScheduleEditorAgentId(next);
    setScheduleEditorSaveState({ status: "saving" });
    try {
      const response = await fetch("/api/admin/platform-config",{
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schedule_editor_agent_id: next }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || "Could not update the scheduler editor agent");
      }
      const effectiveValue = data.data?.schedule_editor_agent_id ?? null;
      setSelectedScheduleEditorAgentId(effectiveValue);
      setSavedScheduleEditorAgentId(effectiveValue);
      setScheduleEditorSource(data.data?.schedule_editor_agent_source || "fallback");
      setScheduleEditorSaveState({ status: "saved" });
    } catch (reason) {
      setSelectedScheduleEditorAgentId(savedScheduleEditorAgentId);
      setScheduleEditorSaveState({
        status: "error",
        error: reason instanceof Error
          ? reason.message
          : "Could not update the scheduler editor agent",
      });
    }
  };

  const selectedAgent = agents.find((agent) => agent._id === selectedAgentId);
  const savedAgentMissing = Boolean(savedAgentId) && !agents.some((agent) => agent._id === savedAgentId);
  const missingSelectedOption = selectedAgentId && !agents.some((agent) => agent._id === selectedAgentId)
    ? { value: selectedAgentId,label: `${selectedAgentId} (not visible to you)` }
    : null;
  const options: AgentPickerOption[] = [
    { value: "",label: "No default agent" },
    ...agents.map((agent) => ({ value: agent._id,label: agent.name })),
    ...(missingSelectedOption ? [missingSelectedOption] : []),
  ];
  const selectedAgentName = selectedAgent?.name ?? selectedAgentId ?? "this agent";
  const selectedScheduleEditorAgent = agents.find(
    (agent) => agent._id === selectedScheduleEditorAgentId,
  );
  const missingScheduleEditorOption = selectedScheduleEditorAgentId && !selectedScheduleEditorAgent
    ? {
        value: selectedScheduleEditorAgentId,
        label: `${selectedScheduleEditorAgentId} (not visible to you)`,
      }
    : null;
  const scheduleEditorOptions: AgentPickerOption[] = [
    { value: "",label: "Use deployment/default chat agent" },
    ...agents.map((agent) => ({ value: agent._id,label: agent.name })),
    ...(missingScheduleEditorOption ? [missingScheduleEditorOption] : []),
  ];

  return (
    <>
      <SettingsCard
        description="This fallback applies only when a person has not chosen a personal default agent."
        title={<span className="flex items-center gap-2"><Bot className="h-5 w-5 text-primary" />Platform default agent</span>}
      >
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading platform default…
          </div>
        ) : loadError ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {loadError}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              Selecting an agent here makes it available to every signed-in user, regardless of agent sharing permissions.
            </div>

            {savedAgentMissing ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                The configured default <code>{savedAgentId}</code> is not in your accessible agent list. It may have been deleted, disabled, or hidden from you.
              </div>
            ) : null}

            {configSource === "env" ? (
              <p className="text-xs text-muted-foreground">
                Currently using the deployment default (<code>DEFAULT_AGENT_ID</code>). Choosing a value here updates the live platform setting.
              </p>
            ) : null}

            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="platform-default-agent">Agent for new chats</label>
              <AgentPicker
                ariaLabel="Platform default agent for new chats"
                disabled={readOnly}
                emptyLabel="No agents match"
                hideIdSuffix
                id="platform-default-agent"
                onChange={selectAgent}
                options={options}
                placeholder="Select the platform default agent..."
                searchPlaceholder="Search agents..."
                triggerClassName="max-w-sm"
                value={selectedAgentId ?? ""}
              />
              {selectedAgent ? (
                <p className="text-xs text-muted-foreground">Agent description: {selectedAgent.description}</p>
              ) : null}
              <AutoSaveStatus state={saveState} />
            </div>
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        description={(
          <>
            Choose the agent opened by <em>Chat with agent</em> when a schedule has no schedule-specific editor agent.
          </>
        )}
        title={<span className="flex items-center gap-2"><CalendarClock className="h-5 w-5 text-primary" />Scheduler editor agent</span>}
      >
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading scheduler editor default…
          </div>
        ) : loadError ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {loadError}
          </div>
        ) : (
          <div className="space-y-4">
            {scheduleEditorSource === "env" ? (
              <p className="text-xs text-muted-foreground">
                Currently using the deployment value (<code>SCHEDULE_EDITOR_AGENT_ID</code>). Choosing another agent here overrides it.
              </p>
            ) : null}
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="schedule-editor-agent">
                Agent for schedule editing
              </label>
              <AgentPicker
                ariaLabel="Scheduler editor agent"
                disabled={readOnly || scheduleEditorSaveState.status === "saving"}
                emptyLabel="No agents match"
                hideIdSuffix
                id="schedule-editor-agent"
                onChange={(value) => void selectScheduleEditorAgent(value)}
                options={scheduleEditorOptions}
                placeholder="Select the scheduler editor agent..."
                searchPlaceholder="Search agents..."
                triggerClassName="max-w-sm"
                value={selectedScheduleEditorAgentId ?? ""}
              />
              {selectedScheduleEditorAgent ? (
                <p className="text-xs text-muted-foreground">
                  Agent description: {selectedScheduleEditorAgent.description}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                This setting does not grant users access to the selected agent.
              </p>
              <AutoSaveStatus state={scheduleEditorSaveState} />
            </div>
          </div>
        )}
      </SettingsCard>

      <Dialog
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
        open={confirmAction !== null}
      >
        <DialogContent>
          {confirmAction === "set" ? (
            <>
              <DialogHeader>
                <DialogTitle>Make “{selectedAgentName}” the platform default?</DialogTitle>
                <DialogDescription>
                  Every signed-in user will be able to use this agent for new chats until the default changes. Connected Slack users may also see it in <code>/caipe-list</code>.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button disabled={saveState.status === "saving"} onClick={cancel} variant="outline">Cancel</Button>
                <Button className="gap-2" disabled={saveState.status === "saving"} onClick={() => void confirm()}>
                  {saveState.status === "saving" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Make it the default
                </Button>
              </DialogFooter>
            </>
          ) : null}
          {confirmAction === "clear" ? (
            <>
              <DialogHeader>
                <DialogTitle>Remove the platform default agent?</DialogTitle>
                <DialogDescription>
                  New chats will no longer open with a fallback agent. Users keep access only through their own choices and team grants.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button disabled={saveState.status === "saving"} onClick={cancel} variant="outline">Cancel</Button>
                <Button className="gap-2" disabled={saveState.status === "saving"} onClick={() => void confirm()}>
                  {saveState.status === "saving" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Remove default
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
