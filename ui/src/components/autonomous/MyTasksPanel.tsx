"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

import { AgentTaskAccordion } from "./AgentTaskAccordion";
import { autonomousApi, AutonomousApiError } from "./api";
import { isTaskOwnedByAgent } from "./taskOwnership";
import { TaskFormDialog } from "./TaskFormDialog";
import { DEFAULT_MINIMUM_SCHEDULE_INTERVAL_SECONDS } from "./formState";
import type { AutonomousTask, TaskSaveResult } from "./types";

export interface MyTasksAgent {
  id: string;
  name: string;
  owner_team_slug: string | null;
}

interface MyTasksPanelProps {
  /** Agents the caller may schedule against -- sections render one per agent. */
  agents: MyTasksAgent[];
  /** Used to filter the task list down to the caller's own tasks. */
  currentUserEmail: string | null;
}

/**
 * Cross-agent "my autonomous tasks" surface. Replaces the per-agent drawer
 * that used to live on the Agents page: one section per agent the caller can
 * schedule against, including agents with no tasks yet, so the page also
 * answers "which agents can I automate?".
 */
export function MyTasksPanel({ agents, currentUserEmail }: MyTasksPanelProps) {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<AutonomousTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<AutonomousTask | null>(null);
  const [dialogAgentId, setDialogAgentId] = useState<string | null>(null);
  const [runHistoryRefreshKey, setRunHistoryRefreshKey] = useState(0);
  const [lastCreatedId, setLastCreatedId] = useState<string | null>(null);
  const [minimumScheduleIntervalSeconds, setMinimumScheduleIntervalSeconds] = useState(
    DEFAULT_MINIMUM_SCHEDULE_INTERVAL_SECONDS,
  );
  // Sections start COLLAPSED: the page can list many agents, and a wall of
  // expanded task lists buries the one the user came for. The header carries a
  // task count so nothing is hidden without a signal.
  const [expandedAgentIds, setExpandedAgentIds] = useState<Set<string>>(new Set());

  const fetchTasks = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setLoading(true);
    try {
      const all = await autonomousApi.listTasks();
      // This page is always "my tasks", including for admins, so keep only
      // tasks owned by the signed-in user if the backend returns a wider set.
      const mine = currentUserEmail
        ? all.filter((t) => t.owner_id === currentUserEmail)
        : all;
      setTasks(mine);
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof AutonomousApiError ? err.message : "Failed to load autonomous tasks.",
      );
      setTasks([]);
    } finally {
      if (!options.silent) setLoading(false);
    }
  }, [currentUserEmail]);

  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  useEffect(() => {
    void autonomousApi
      .getSettings()
      .then((settings) => {
        setMinimumScheduleIntervalSeconds(settings.minimum_schedule_interval_seconds);
      })
      .catch(() => {
        // Keep the chart default in the form. The backend remains authoritative
        // and returns its configured limit if the save is attempted.
      });
  }, []);

  const hasPendingAck = useMemo(
    () => tasks.some((task) => task.last_ack?.ack_status === "pending"),
    [tasks],
  );

  useEffect(() => {
    if (!hasPendingAck) return;
    const interval = setInterval(() => {
      void fetchTasks({ silent: true });
    }, 5000);
    return () => clearInterval(interval);
  }, [hasPendingAck, fetchTasks]);

  // Agents with tasks first, then empty ones; alphabetical within each group.
  const sections = useMemo(() => {
    const byAgent = agents.map((agent) => ({
      agent,
      tasks: tasks.filter((t) => isTaskOwnedByAgent(t, agent.id)),
    }));
    return byAgent.sort((a, b) => {
      const aEmpty = a.tasks.length === 0 ? 1 : 0;
      const bEmpty = b.tasks.length === 0 ? 1 : 0;
      if (aEmpty !== bEmpty) return aEmpty - bEmpty;
      return a.agent.name.localeCompare(b.agent.name);
    });
  }, [agents, tasks]);

  const markBusy = (id: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleSection = (agentId: string) => {
    setExpandedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const handleCreate = (agentId: string) => {
    setEditingTask(null);
    setDialogAgentId(agentId);
    setDialogOpen(true);
  };

  const handleEdit = (task: AutonomousTask) => {
    setEditingTask(task);
    setDialogAgentId(task.dynamic_agent_id ?? null);
    setDialogOpen(true);
  };

  const handleSubmitTask = async (task: AutonomousTask): Promise<TaskSaveResult> => {
    if (editingTask) {
      const saved = await autonomousApi.updateTask(editingTask.id, task);
      const updated = saved.task;
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      toast(`Task "${updated.name}" updated.`, "success");
      return saved;
    } else {
      const created = await autonomousApi.createTask(task);
      setTasks((prev) => [...prev, created.task]);
      setLastCreatedId(created.task.id);
      // Reveal the section the new task landed in -- sections default to
      // collapsed, so otherwise a just-created task would be invisible.
      const createdAgentId = created.task.dynamic_agent_id ?? dialogAgentId;
      if (createdAgentId) {
        setExpandedAgentIds((prev) => new Set(prev).add(createdAgentId));
      }
      toast(`Task "${created.task.name}" created.`, "success");
      return created;
    }
  };

  const handleSaveWebhookSecret = async (
    task: AutonomousTask,
    secret: string,
  ): Promise<AutonomousTask> => {
    if (task.trigger.type !== "webhook") {
      throw new Error("Only webhook tasks have signing secrets.");
    }
    const saved = await autonomousApi.updateTask(task.id, {
      ...task,
      trigger: { ...task.trigger, secret },
    });
    const updated = saved.task;
    setTasks((prev) => prev.map((existing) => (existing.id === updated.id ? updated : existing)));
    toast("Signing secret saved securely.", "success");
    return updated;
  };

  const handleDelete = async (task: AutonomousTask) => {
    if (!window.confirm(`Delete task "${task.name}"? This cannot be undone.`)) return;
    markBusy(task.id, true);
    try {
      await autonomousApi.deleteTask(task.id);
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
      if (lastCreatedId === task.id) setLastCreatedId(null);
      toast(`Task "${task.name}" deleted.`, "success");
    } catch (err) {
      toast(err instanceof AutonomousApiError ? err.message : "Failed to delete task", "error");
    } finally {
      markBusy(task.id, false);
    }
  };

  const handleTrigger = async (task: AutonomousTask) => {
    markBusy(task.id, true);
    try {
      await autonomousApi.triggerTask(task.id);
      toast(`Triggered "${task.name}". Run history will update shortly.`, "success");
      setRunHistoryRefreshKey((n) => n + 1);
      try {
        const refreshed = await autonomousApi.getTask(task.id);
        setTasks((prev) => prev.map((t) => (t.id === refreshed.id ? refreshed : t)));
      } catch {
        // Non-fatal; the next reload picks up the updated next_run.
      }
    } catch (err) {
      toast(err instanceof AutonomousApiError ? err.message : "Failed to trigger task", "error");
    } finally {
      markBusy(task.id, false);
    }
  };

  if (loadError) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        <span>{loadError}</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => void fetchTasks()}>
          Retry
        </Button>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
        {/* Reached by any member of an autonomous-eligible team before their
            team admin has enabled any individual agent (Layer 2). The nav entry
            is deliberately visible in this state so the ask is discoverable. */}
        No agents have autonomous turned on yet. Ask your team admin to turn on autonomous for the
        agents your team uses.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {sections.map(({ agent, tasks: agentTasks }) => {
        const isExpanded = expandedAgentIds.has(agent.id);
        return (
          <section key={agent.id} className="rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => toggleSection(agent.id)}
                aria-expanded={isExpanded}
              >
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate text-sm font-semibold" data-testid="agent-section-name">
                  {agent.name}
                </span>
                {agent.owner_team_slug && (
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {agent.owner_team_slug}
                  </Badge>
                )}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {agentTasks.length} {agentTasks.length === 1 ? "task" : "tasks"}
                </span>
              </button>
              <Button size="sm" variant="outline" onClick={() => handleCreate(agent.id)}>
                + New task
              </Button>
            </div>

            {isExpanded && (
              <div className="border-t border-border px-4 py-3">
                {agentTasks.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    {loading ? "Loading…" : "No tasks yet — create one."}
                  </p>
                ) : (
                  <AgentTaskAccordion
                    tasks={agentTasks}
                    busyIds={busyIds}
                    runHistoryRefreshKey={runHistoryRefreshKey}
                    defaultExpandedId={lastCreatedId}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                    onTrigger={handleTrigger}
                  />
                )}
              </div>
            )}
          </section>
        );
      })}

      <TaskFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        task={editingTask}
        initialAgentId={dialogAgentId}
        // The caller's OTHER task names, so the form can flag a duplicate
        // without counting the task currently being edited as its own clash.
        existingNames={tasks
          .filter((t) => t.id !== editingTask?.id)
          .map((t) => t.name)}
        minimumScheduleIntervalSeconds={minimumScheduleIntervalSeconds}
        onSubmit={handleSubmitTask}
        onSaveWebhookSecret={handleSaveWebhookSecret}
      />
    </div>
  );
}
