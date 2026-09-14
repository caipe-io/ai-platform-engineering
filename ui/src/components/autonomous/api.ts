// Copyright CAIPE Contributors (https://caipe.io)
// SPDX-License-Identifier: Apache-2.0

import type {
  AutonomousRuntimeSettings,
  AutonomousTask,
  TaskRun,
  TaskRunFollowUpResult,
  TaskSaveResult,
} from './types';
// Note: ``TaskRun`` is exported because consumers like ``RunHistory``
// type-narrow on it. Keep this barrel-style re-export below in mind
// when adjusting the API surface.

export type { AutonomousTask, TaskRun };

type TaskMutationResponse = AutonomousTask & {
  webhook_setup?: { secret?: string };
};

function toTaskSaveResult(saved: TaskMutationResponse): TaskSaveResult {
  const { webhook_setup: webhookSetup, ...task } = saved;
  return {
    task,
    webhookSetupRequired: webhookSetup !== undefined,
    webhookSetupSecret: webhookSetup?.secret,
  };
}

/**
 * Tiny client for the autonomous-agents proxy.
 *
 * Lives next to the components rather than in `src/lib` because every
 * caller is inside the autonomous tab -- inlining keeps the contract
 * (paths, error envelope) co-located with the consumers and avoids
 * polluting the global API surface for the rest of the UI.
 *
 * All routes go through `/api/autonomous/...`, which is the Next.js
 * proxy that adds the session check and forwards to the FastAPI
 * service (see `app/api/autonomous/[...path]/route.ts`).
 */

const BASE = '/api/autonomous';

export class AutonomousApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown, message: string) {
    super(message);
    this.name = 'AutonomousApiError';
    this.status = status;
    this.detail = detail;
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 204) {
    // Coerce to ``T`` -- DELETE returns void, the type system enforces
    // that the caller declares ``void`` here.
    return undefined as T;
  }

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  if (!response.ok) {
    // FastAPI uses ``{"detail": "..."}``; the proxy preserves it.
    const detail =
      (parsed as { detail?: unknown; error?: unknown } | undefined)?.detail ??
      (parsed as { error?: unknown } | undefined)?.error ??
      response.statusText;
    throw new AutonomousApiError(
      response.status,
      parsed,
      typeof detail === 'string' ? detail : `Request failed (${response.status})`,
    );
  }

  return parsed as T;
}

export const autonomousApi = {
  getSettings: (): Promise<AutonomousRuntimeSettings> => request('/settings'),
  listTasks: (): Promise<AutonomousTask[]> => request('/tasks'),
  getTask: (id: string): Promise<AutonomousTask> => request(`/tasks/${encodeURIComponent(id)}`),
  createTask: async (task: AutonomousTask): Promise<TaskSaveResult> =>
    toTaskSaveResult(await request<TaskMutationResponse>('/tasks', {
      method: 'POST',
      body: JSON.stringify(task),
    })),
  updateTask: async (id: string, task: AutonomousTask): Promise<TaskSaveResult> =>
    toTaskSaveResult(await request<TaskMutationResponse>(`/tasks/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(task),
    })),
  deleteTask: (id: string): Promise<void> =>
    request(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  triggerTask: (id: string): Promise<{ status: string; task_id: string }> =>
    request(`/tasks/${encodeURIComponent(id)}/run`, { method: 'POST' }),
  listRuns: (id: string): Promise<TaskRun[]> =>
    request(`/tasks/${encodeURIComponent(id)}/runs`),
  followUpRun: (
    taskId: string,
    runId: string,
    userText: string,
  ): Promise<TaskRunFollowUpResult> =>
    request(
      `/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/follow-up`,
      {
        method: 'POST',
        body: JSON.stringify({ user_text: userText }),
      },
    ),
};
