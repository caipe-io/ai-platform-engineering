"use client";

import React, { useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Pencil, Play, Trash2, MessageSquare } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RunHistory } from "./RunHistory";
import { WebhookHookPath } from "./WebhookHookPath";
import {
  ackBadgeFor,
  ackTooltip,
  describeTrigger,
  formatNextRun,
  formatRelative,
  TriggerIcon,
} from "@/components/autonomous/taskPresentation";
import type { AutonomousTask } from "@/components/autonomous/types";

interface AgentTaskAccordionProps {
  tasks: AutonomousTask[];
  /** ids currently being acted on (delete/trigger) — used to disable buttons. */
  busyIds: Set<string>;
  /** Bumped by the parent after a trigger to force expanded run histories to reload. */
  runHistoryRefreshKey: number;
  /** Auto-expand this id (e.g. a just-created task) without collapsing others. */
  defaultExpandedId?: string | null;
  onEdit: (task: AutonomousTask) => void;
  onDelete: (task: AutonomousTask) => void;
  onTrigger: (task: AutonomousTask) => void;
}

/**
 * Drawer-only, list-first accordion. Compact
 * one-line rows expand inline to reveal detail + actions + run history.
 * Multiple rows can be open at once.
 */
export function AgentTaskAccordion({
  tasks,
  busyIds,
  runHistoryRefreshKey,
  defaultExpandedId = null,
  onEdit,
  onDelete,
  onTrigger,
}: AgentTaskAccordionProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(defaultExpandedId ? [defaultExpandedId] : []),
  );

  // Open a newly-provided id (e.g. a just-created task) additively — never
  // collapse whatever the operator already has open. Uses React's
  // adjust-state-during-render pattern (keyed on the previous prop value)
  // instead of an effect, so the row is open on first paint.
  const [prevDefaultExpandedId, setPrevDefaultExpandedId] = useState(defaultExpandedId);
  if (defaultExpandedId !== prevDefaultExpandedId) {
    setPrevDefaultExpandedId(defaultExpandedId);
    if (defaultExpandedId && !expandedIds.has(defaultExpandedId)) {
      const next = new Set(expandedIds);
      next.add(defaultExpandedId);
      setExpandedIds(next);
    }
  }

  const toggle = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <ul className="flex flex-col gap-2">
      {tasks.map((task) => {
        const isOpen = expandedIds.has(task.id);
        const isBusy = busyIds.has(task.id);
        const ack = ackBadgeFor(task.last_ack);
        return (
          <li
            key={task.id}
            className={cn(
              "rounded-lg border bg-card text-card-foreground transition-colors",
              isOpen ? "border-primary/50" : "border-border hover:border-primary/40",
              !task.enabled && "opacity-70",
            )}
          >
            {/* Collapsed one-line summary — the whole row is the toggle. */}
            <button
              type="button"
              onClick={() => toggle(task.id)}
              aria-expanded={isOpen}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
            >
              <span
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  task.enabled ? "bg-primary" : "border border-muted-foreground/50",
                )}
                title={task.enabled ? "Enabled" : "Disabled"}
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {task.name}
              </span>
              <span className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex">
                <TriggerIcon type={task.trigger.type} />
                {describeTrigger(task.trigger)}
              </span>
              <Badge
                variant="outline"
                className={cn("shrink-0 gap-1 text-[10px]", ack.className)}
                title={ackTooltip(task.last_ack)}
                data-testid={`autonomous-ack-${ack.status}`}
              >
                {ack.icon}
              </Badge>
              <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">
                {formatRelative(task.next_run) || "—"}
              </span>
              {isOpen ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
            </button>

            {isOpen && (
              <div className="space-y-3 border-t border-border px-3 py-3">
                {task.description && (
                  <p className="text-xs text-muted-foreground">{task.description}</p>
                )}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span>{task.enabled ? "Enabled" : "Disabled"}</span>
                  <Badge
                    variant="outline"
                    className={cn("gap-1 text-[10px]", ack.className)}
                    title={ackTooltip(task.last_ack)}
                  >
                    {ack.icon}
                    {ack.label}
                  </Badge>
                  <span title={task.next_run ? new Date(task.next_run).toISOString() : ""}>
                    next run: {formatNextRun(task.next_run)}
                  </span>
                  {task.trigger.type === "webhook" && (
                    <WebhookHookPath taskId={task.id} />
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onTrigger(task)}
                    disabled={isBusy || !task.enabled}
                    title={task.enabled ? "Run now" : "Enable the task to run it"}
                  >
                    <Play className="h-3.5 w-3.5" />
                    <span className="ml-1 text-xs">Run</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onEdit(task)}
                    disabled={isBusy}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    <span className="ml-1 text-xs">Edit</span>
                  </Button>
                  {task.chat_conversation_id && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      asChild
                      title="View this task's chat thread"
                    >
                      <Link
                        href={`/chat/${task.chat_conversation_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid="autonomous-thread-link"
                      >
                        <MessageSquare className="h-3.5 w-3.5" />
                        <span className="ml-1 text-xs">Thread</span>
                      </Link>
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onDelete(task)}
                    disabled={isBusy}
                    className="text-red-600 hover:bg-red-500/10 hover:text-red-700"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span className="ml-1 text-xs">Delete</span>
                  </Button>
                </div>

                <RunHistory
                  taskId={task.id}
                  triggerType={task.trigger.type}
                  refreshKey={runHistoryRefreshKey}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
