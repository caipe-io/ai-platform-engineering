// GET /api/schedules - List scheduler jobs owned by the current user

import { NextRequest } from "next/server";
import { getCollection } from "@/lib/mongodb";
import {
  successResponse,
  withAuth,
  withErrorHandler,
} from "@/lib/api-middleware";

export const dynamic = "force-dynamic";

interface RawSchedule {
  schedule_id: string;
  owner_user_id: string;
  agent_id: string;
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

type OneOffRunStatus =
  | "pending"
  | "claimed"
  | "fired"
  | "succeeded"
  | "failed"
  | "cancelled";

interface RawOneOffRun {
  one_off_run_id: string;
  schedule_id: string;
  owner_user_id: string;
  run_at?: Date | string;
  status?: OneOffRunStatus;
  message_template?: string | null;
  reason?: string | null;
  retry_num?: number | null;
  retry_limit?: number | null;
  job_name?: string | null;
  error?: string | null;
  http_status?: number | null;
  created_at?: Date | string;
  updated_at?: Date | string;
  claimed_at?: Date | string | null;
  fired_at?: Date | string | null;
  completed_at?: Date | string | null;
}

interface RawScheduleVersion {
  version?: number;
  superseded_at?: Date | string | null;
  changed_fields?: string[];
  title?: string | null;
  agent_id?: string;
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

const ACTIVE_ONE_OFF_STATUSES: OneOffRunStatus[] = ["pending", "claimed", "fired"];
const COMPLETED_ONE_OFF_STATUSES: OneOffRunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
];
const RECENT_COMPLETED_ONE_OFFS_PER_SCHEDULE = 5;
const DEFAULT_MINIMUM_SCHEDULE_INTERVAL_SECONDS = 30 * 60;

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

async function getMinimumScheduleIntervalSeconds(): Promise<number> {
  try {
    const token = schedulerToken();
    const response = await fetch(`${schedulerBaseUrl()}/v1/settings`, {
      headers: token ? { "X-Scheduler-Token": token } : {},
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`scheduler returned ${response.status}`);
    }
    const body = (await response.json()) as {
      minimum_schedule_interval_seconds?: unknown;
    };
    const minimum = body.minimum_schedule_interval_seconds;
    if (typeof minimum !== "number" || !Number.isInteger(minimum) || minimum < 1) {
      throw new Error("scheduler returned an invalid minimum interval");
    }
    return minimum;
  } catch (error) {
    console.warn(
      "Could not load scheduler runtime settings; using the default minimum interval.",
      error,
    );
    return DEFAULT_MINIMUM_SCHEDULE_INTERVAL_SECONDS;
  }
}

function iso(value: Date | string | undefined | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function mapOneOffRun(doc: RawOneOffRun) {
  return {
    one_off_run_id: doc.one_off_run_id,
    schedule_id: doc.schedule_id,
    run_at: iso(doc.run_at),
    status: doc.status || "pending",
    message_template: doc.message_template || null,
    reason: doc.reason || null,
    retry_num: doc.retry_num ?? null,
    retry_limit: doc.retry_limit ?? null,
    job_name: doc.job_name || null,
    error: doc.error || null,
    http_status: doc.http_status ?? null,
    created_at: iso(doc.created_at),
    updated_at: iso(doc.updated_at),
    claimed_at: iso(doc.claimed_at),
    fired_at: iso(doc.fired_at),
    completed_at: iso(doc.completed_at),
  };
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

function oneOffSortRank(status?: OneOffRunStatus): number {
  if (status === "pending") return 0;
  if (status === "claimed") return 1;
  if (status === "fired") return 2;
  return 3;
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (_req, user) => {
    const minimumScheduleIntervalSecondsPromise =
      getMinimumScheduleIntervalSeconds();
    const schedules = await getCollection<RawSchedule>("schedules");
    const agents = await getCollection<{ _id: string; name?: string }>("dynamic_agents");
    const oneOffRuns = await getCollection<RawOneOffRun>("schedule_one_off_runs");

    const docs = await schedules
      .find({ owner_user_id: user.email })
      .sort({ created_at: -1 })
      .limit(200)
      .toArray();

    const agentIds = Array.from(new Set(docs.map((doc) => doc.agent_id).filter(Boolean)));
    const agentNames = new Map<string, string>();

    if (agentIds.length > 0) {
      const agentDocs = await agents
        .find({ _id: { $in: agentIds } })
        .project({ _id: 1, name: 1 })
        .toArray();

      for (const agent of agentDocs) {
        agentNames.set(agent._id, agent.name || agent._id);
      }
    }

    const scheduleIds = docs.map((doc) => doc.schedule_id).filter(Boolean);
    const oneOffRunsBySchedule = new Map<string, ReturnType<typeof mapOneOffRun>[]>();

    if (scheduleIds.length > 0) {
      const activeOneOffDocs = await oneOffRuns
        .find({
          owner_user_id: user.email,
          schedule_id: { $in: scheduleIds },
          status: { $in: ACTIVE_ONE_OFF_STATUSES },
        })
        .sort({ run_at: 1, created_at: 1 })
        .limit(500)
        .toArray();

      const recentCompletedDocs = await oneOffRuns
        .aggregate<RawOneOffRun>([
          {
            $match: {
              owner_user_id: user.email,
              schedule_id: { $in: scheduleIds },
              status: { $in: COMPLETED_ONE_OFF_STATUSES },
            },
          },
          { $sort: { run_at: -1, completed_at: -1, created_at: -1 } },
          {
            $group: {
              _id: "$schedule_id",
              runs: { $push: "$$ROOT" },
            },
          },
          {
            $project: {
              runs: {
                $slice: ["$runs", RECENT_COMPLETED_ONE_OFFS_PER_SCHEDULE],
              },
            },
          },
          { $unwind: "$runs" },
          { $replaceRoot: { newRoot: "$runs" } },
        ])
        .toArray();

      for (const doc of [...activeOneOffDocs, ...recentCompletedDocs]) {
        const mapped = mapOneOffRun(doc);
        const runs = oneOffRunsBySchedule.get(doc.schedule_id) || [];
        runs.push(mapped);
        oneOffRunsBySchedule.set(doc.schedule_id, runs);
      }

      for (const [scheduleId, runs] of oneOffRunsBySchedule) {
        runs.sort((a, b) => {
          const rankDelta = oneOffSortRank(a.status) - oneOffSortRank(b.status);
          if (rankDelta !== 0) return rankDelta;

          const aTime = Date.parse(a.run_at || a.completed_at || a.created_at || "");
          const bTime = Date.parse(b.run_at || b.completed_at || b.created_at || "");
          const aValid = Number.isNaN(aTime) ? 0 : aTime;
          const bValid = Number.isNaN(bTime) ? 0 : bTime;

          return oneOffSortRank(a.status) < 3
            ? aValid - bValid
            : bValid - aValid;
        });
        oneOffRunsBySchedule.set(scheduleId, runs);
      }
    }

    const minimumScheduleIntervalSeconds =
      await minimumScheduleIntervalSecondsPromise;

    return successResponse({
      items: docs.map((doc) => ({
        schedule_id: doc.schedule_id,
        owner_user_id: doc.owner_user_id,
        agent_id: doc.agent_id,
        edit_agent_id: doc.edit_agent_id || null,
        agent_name: agentNames.get(doc.agent_id) || doc.agent_id,
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
        one_off_runs: oneOffRunsBySchedule.get(doc.schedule_id) || [],
      })),
      total: docs.length,
      server_now: new Date().toISOString(),
      minimum_schedule_interval_seconds: minimumScheduleIntervalSeconds,
    });
  });
});
