// PATCH /api/schedules/[id] - Edit or pause/restart a scheduler job owned by the current user.
// DELETE /api/schedules/[id] - Delete a scheduler job owned by the current user.

import { NextRequest } from "next/server";
import { getCollection } from "@/lib/mongodb";
import {
  ApiError,
  successResponse,
  withAuth,
  withErrorHandler,
} from "@/lib/api-middleware";

export const dynamic = "force-dynamic";

interface RawSchedule {
  schedule_id: string;
  owner_user_id: string;
  agent_id: string;
  project_id?: string | null;
  edit_agent_id?: string | null;
  title?: string | null;
  message_template: string;
  attributes?: Record<string, unknown> | null;
  cron: string;
  tz: string;
  enabled?: boolean;
  cronjob_name?: string | null;
  version?: number;
  versions?: RawScheduleVersion[];
  events?: RawScheduleEvent[];
  created_at?: Date | string;
  updated_at?: Date | string;
  last_run?: {
    ts?: Date | string;
    status?: "ok" | "error";
    error?: string | null;
    http_status?: number | null;
  } | null;
}

interface RawScheduleVersion {
  version?: number;
  superseded_at?: Date | string | null;
  changed_fields?: string[];
  title?: string | null;
  agent_id?: string;
  project_id?: string | null;
  edit_agent_id?: string | null;
  message_template?: string;
  attributes?: Record<string, unknown> | null;
  cron?: string;
  tz?: string;
  enabled?: boolean;
  cronjob_name?: string | null;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
}

interface RawScheduleEvent {
  event_id?: string;
  event_type?: string;
  occurred_at?: Date | string | null;
  actor_type?: "user" | "admin" | "system";
  actor_id?: string;
  source?: string;
  changed_fields?: string[];
  changes?: Record<string, { before?: unknown; after?: unknown }>;
}

interface SchedulerPatchBody {
  agent_id?: unknown;
  project_id?: unknown;
  edit_agent_id?: unknown;
  enabled?: unknown;
  action?: unknown;
  cron?: unknown;
  tz?: unknown;
  message_template?: unknown;
  title?: unknown;
  attributes?: unknown;
}

function iso(value: Date | string | undefined | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function mapScheduleEvent(event: RawScheduleEvent) {
  return {
    event_id: event.event_id || "",
    event_type: event.event_type || "runner_image_reconciled",
    occurred_at: iso(event.occurred_at),
    actor_type: event.actor_type || "system",
    actor_id: event.actor_id || "caipe-scheduler",
    source: event.source || "deployment_reconcile",
    changed_fields: event.changed_fields || [],
    changes: event.changes || {},
  };
}

function schedulerBaseUrl(): string {
  return (
    process.env.SCHEDULER_URL ||
    process.env.CAIPE_SCHEDULER_URL ||
    "http://caipe-scheduler:8080"
  ).replace(/\/+$/, "");
}

function schedulerToken(): string {
  return (
    process.env.SCHEDULER_SERVICE_TOKEN ||
    process.env.CAIPE_SCHEDULER_SERVICE_TOKEN ||
    ""
  );
}

function callerToken(session: unknown): string {
  const token = (session as { accessToken?: unknown } | null)?.accessToken;
  if (typeof token !== "string" || !token.trim()) {
    throw new ApiError("Your session has no access token. Sign in again.", 401);
  }
  return token.trim();
}

function buildSchedulerPatch(body: SchedulerPatchBody) {
  const patch: {
    agent_id?: string;
    project_id?: string | null;
    edit_agent_id?: string | null;
    enabled?: boolean;
    cron?: string;
    tz?: string;
    message_template?: string;
    title?: string;
    attributes?: Record<string, unknown>;
  } = {};

  if (body.agent_id !== undefined) {
    if (typeof body.agent_id !== "string" || !body.agent_id.trim()) {
      throw new ApiError("agent_id must be a non-empty string", 400);
    }
    patch.agent_id = body.agent_id.trim();
  }

  if (body.project_id !== undefined) {
    if (body.project_id === null) {
      patch.project_id = null;
    } else if (
      typeof body.project_id !== "string" ||
      !body.project_id.trim()
    ) {
      throw new ApiError("project_id must be a non-empty string or null", 400);
    } else {
      patch.project_id = body.project_id.trim();
    }
  }

  if (body.edit_agent_id !== undefined) {
    if (body.edit_agent_id === null) {
      patch.edit_agent_id = null;
    } else if (typeof body.edit_agent_id !== "string" || !body.edit_agent_id.trim()) {
      throw new ApiError("edit_agent_id must be a non-empty string or null", 400);
    } else {
      patch.edit_agent_id = body.edit_agent_id.trim();
    }
  }

  if (body.action !== undefined) {
    if (body.action === "pause") {
      patch.enabled = false;
    } else if (body.action === "resume" || body.action === "restart") {
      patch.enabled = true;
    } else {
      throw new ApiError("Unsupported schedule action", 400);
    }
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      throw new ApiError("enabled must be a boolean", 400);
    }
    patch.enabled = body.enabled;
  }

  if (body.cron !== undefined) {
    if (typeof body.cron !== "string" || !body.cron.trim()) {
      throw new ApiError("cron must be a non-empty string", 400);
    }
    patch.cron = body.cron.trim();
  }

  if (body.tz !== undefined) {
    if (typeof body.tz !== "string" || !body.tz.trim()) {
      throw new ApiError("tz must be a non-empty string", 400);
    }
    patch.tz = body.tz.trim();
  }

  if (body.message_template !== undefined) {
    if (typeof body.message_template !== "string" || !body.message_template.trim()) {
      throw new ApiError("message_template must be a non-empty string", 400);
    }
    patch.message_template = body.message_template;
  }

  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) {
      throw new ApiError("title must be a non-empty string", 400);
    }
    patch.title = body.title.trim();
  }

  if (body.attributes !== undefined) {
    if (
      !body.attributes ||
      typeof body.attributes !== "object" ||
      Array.isArray(body.attributes)
    ) {
      throw new ApiError("attributes must be a JSON object", 400);
    }
    patch.attributes = body.attributes as Record<string, unknown>;
  }

  if (Object.keys(patch).length === 0) {
    throw new ApiError(
      "Request body must include agent_id, project_id, edit_agent_id, enabled/action, cron, tz, message_template, title, or attributes",
      400
    );
  }

  return patch;
}

function schedulerErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const errorBody = body as { detail?: unknown; error?: unknown };
    if (errorBody.detail) return String(errorBody.detail);
    if (errorBody.error) return String(errorBody.error);
  }
  return `Scheduler service returned ${status}`;
}

function mapSchedule(doc: RawSchedule, agentName: string) {
  return {
    schedule_id: doc.schedule_id,
    owner_user_id: doc.owner_user_id,
    agent_id: doc.agent_id,
    project_id: doc.project_id || null,
    edit_agent_id: doc.edit_agent_id || null,
    agent_name: agentName || doc.agent_id,
    title: doc.title || null,
    message_template: doc.message_template,
    attributes: doc.attributes || {},
    cron: doc.cron,
    tz: doc.tz,
    enabled: doc.enabled !== false,
    cronjob_name: doc.cronjob_name || null,
    version: doc.version || 1,
    versions: (doc.versions || [])
      .slice()
      .reverse()
      .map((version) => ({
        version: version.version || 1,
        superseded_at: iso(version.superseded_at),
        changed_fields: version.changed_fields || [],
        title: version.title || null,
        agent_id: version.agent_id || doc.agent_id,
        project_id: version.project_id || null,
        edit_agent_id: version.edit_agent_id || null,
        message_template: version.message_template || "",
        attributes: version.attributes || {},
        cron: version.cron || "",
        tz: version.tz || "",
        enabled: version.enabled !== false,
        cronjob_name: version.cronjob_name || null,
        created_at: iso(version.created_at),
        updated_at: iso(version.updated_at),
      })),
    events: (doc.events || []).map(mapScheduleEvent),
    created_at: iso(doc.created_at),
    updated_at: iso(doc.updated_at),
    last_run: doc.last_run
      ? {
          ts: iso(doc.last_run.ts),
          status: doc.last_run.status || null,
          error: doc.last_run.error || null,
          http_status: doc.last_run.http_status || null,
        }
      : null,
  };
}

async function patchScheduler(
  scheduleId: string,
  patch: ReturnType<typeof buildSchedulerPatch>,
  accessToken: string,
): Promise<RawSchedule> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  const token = schedulerToken();
  if (token) {
    headers["X-Scheduler-Token"] = token;
  }

  let response: Response;
  try {
    response = await fetch(
      `${schedulerBaseUrl()}/v1/schedules/${encodeURIComponent(scheduleId)}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify(patch),
        cache: "no-store",
      }
    );
  } catch (error) {
    throw new ApiError(
      error instanceof Error
        ? `Scheduler service is unavailable: ${error.message}`
        : "Scheduler service is unavailable",
      502
    );
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const message = schedulerErrorMessage(body, response.status);
    throw new ApiError(String(message), response.status < 500 ? response.status : 502);
  }

  return body as RawSchedule;
}

async function deleteScheduler(
  scheduleId: string,
  accessToken: string,
): Promise<{ deleted: string }> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${accessToken}`,
  };
  const token = schedulerToken();
  if (token) {
    headers["X-Scheduler-Token"] = token;
  }

  let response: Response;
  try {
    response = await fetch(
      `${schedulerBaseUrl()}/v1/schedules/${encodeURIComponent(scheduleId)}`,
      {
        method: "DELETE",
        headers,
        cache: "no-store",
      }
    );
  } catch (error) {
    throw new ApiError(
      error instanceof Error
        ? `Scheduler service is unavailable: ${error.message}`
        : "Scheduler service is unavailable",
      502
    );
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const message = schedulerErrorMessage(body, response.status);
    throw new ApiError(String(message), response.status < 500 ? response.status : 502);
  }

  return body as { deleted: string };
}

export const PATCH = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const { id: scheduleId } = await context.params;
    if (!scheduleId) {
      throw new ApiError("Schedule ID is required", 400);
    }

    return withAuth(request, async (_req, user, session) => {
      const schedules = await getCollection<RawSchedule>("schedules");
      const existing = await schedules.findOne({
        schedule_id: scheduleId,
        owner_user_id: user.email,
      });

      if (!existing) {
        throw new ApiError("Schedule not found", 404);
      }

      const body = (await request.json().catch(() => ({}))) as SchedulerPatchBody;
      const patch = buildSchedulerPatch(body);
      const updated = await patchScheduler(scheduleId, patch, callerToken(session));

      const agents = await getCollection<{ _id: string; name?: string }>("dynamic_agents");
      const agent = await agents.findOne(
        { _id: updated.agent_id || existing.agent_id },
        { projection: { _id: 1, name: 1 } }
      );

      return successResponse(mapSchedule(updated, agent?.name || existing.agent_id));
    });
  }
);

export const DELETE = withErrorHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const { id: scheduleId } = await context.params;
    if (!scheduleId) {
      throw new ApiError("Schedule ID is required", 400);
    }

    return withAuth(request, async (_req, user, session) => {
      const schedules = await getCollection<RawSchedule>("schedules");
      const existing = await schedules.findOne({
        schedule_id: scheduleId,
        owner_user_id: user.email,
      });

      if (!existing) {
        throw new ApiError("Schedule not found", 404);
      }

      const deleted = await deleteScheduler(scheduleId, callerToken(session));
      return successResponse(deleted);
    });
  }
);
