/**
 * Workflows MCP server, hosted inside the BFF.
 *
 * Each tool builds an in-process request that carries the caller's bearer token and
 * calls the existing workflow route handler, so workflow visibility, run ownership
 * and OpenFGA checks apply exactly as they do for the REST API. Nothing here
 * authorizes on its own, and identity is never a tool argument.
 *
 * Not exposed: `PUT /api/workflow-runs?id=`. It writes the request body straight
 * into the run document, so a tool for it could overwrite fields such as `status`
 * or `owner_id`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { NextRequest } from "next/server";
import { z } from "zod";

import * as checkAccessRoute from "@/app/api/workflow-configs/check-agent-access/route";
import * as configsRoute from "@/app/api/workflow-configs/route";
import * as cancelRoute from "@/app/api/workflow-runs/[id]/cancel/route";
import * as resumeRoute from "@/app/api/workflow-runs/[id]/resume/route";
import * as runRoute from "@/app/api/workflow-runs/[id]/route";
import * as runsRoute from "@/app/api/workflow-runs/route";

export interface WorkflowsMcpContext {
  /** The caller's `Authorization` header, forwarded to every route handler. */
  authorization: string;
  /** Origin used to build in-process request URLs. */
  origin: string;
}

type RouteHandler = (request: NextRequest, context: never) => Promise<Response>;

interface RouteCall {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  search?: Record<string, string>;
  body?: unknown;
  /** Next.js route context, for `[id]` routes. */
  context?: { params: Promise<{ id: string }> };
}

const ERROR_TEXT_LIMIT = 300;

/** A failure reported by a workflow route, or by tool-level validation. */
export class WorkflowToolError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WorkflowToolError";
  }
}

function errorMessage(json: unknown, text: string): string {
  if (json && typeof json === "object") {
    for (const key of ["error", "message", "detail"] as const) {
      const value = (json as Record<string, unknown>)[key];
      if (typeof value === "string" && value) return value.slice(0, ERROR_TEXT_LIMIT);
    }
  }
  return text.slice(0, ERROR_TEXT_LIMIT) || "no details";
}

/** `{ success: true, data }` bodies are unwrapped; bare JSON passes through. */
function unwrap(json: unknown): unknown {
  if (json && typeof json === "object" && (json as { success?: unknown }).success === true && "data" in json) {
    return (json as { data: unknown }).data;
  }
  return json;
}

async function callRoute(ctx: WorkflowsMcpContext, handler: RouteHandler, call: RouteCall): Promise<unknown> {
  const url = new URL(call.path, ctx.origin);
  for (const [key, value] of Object.entries(call.search ?? {})) url.searchParams.set(key, value);

  const headers = new Headers({ authorization: ctx.authorization, accept: "application/json" });
  let body: string | undefined;
  if (call.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(call.body);
  }

  const request = new NextRequest(url, { method: call.method, headers, body });
  const response = await handler(request, (call.context ?? { params: Promise.resolve({}) }) as never);

  const text = await response.text();
  let json: unknown;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  if (!response.ok) {
    throw new WorkflowToolError(`CAIPE API returned HTTP ${response.status}: ${errorMessage(json, text)}`, response.status);
  }
  return unwrap(json) ?? {};
}

function succeed(result: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

function fail(error: unknown): CallToolResult {
  if (error instanceof WorkflowToolError) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
  console.error("[workflows-mcp] unexpected tool error:", error);
  return { isError: true, content: [{ type: "text", text: "Unexpected error while calling the workflow API." }] };
}

async function respond(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return succeed(await work());
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const workflowId = z.string().min(1).describe("The workflow config id.");
const runId = z.string().min(1).describe("The workflow run id.");

const stepSchema = z
  .object({
    type: z.literal("step").default("step"),
    display_text: z.string().min(1).describe("Short label shown for this step in the UI."),
    agent_id: z
      .string()
      .min(1)
      .describe("Dynamic agent _id that runs this step, for example 'agent-weather-agent'. The run's owner must be able to use it."),
    prompt: z.string().min(1).describe("The message sent to the agent for this step."),
    on_error: z.enum(["abort", "skip", "retry"]).default("abort").describe("What to do when the step fails. 'retry' requires `retry`."),
    retry: z
      .object({ max_attempts: z.number().int().min(1).default(3).describe("Total attempts. At least 1.") })
      .nullish(),
    config_override: z.record(z.string(), z.unknown()).nullish().describe("Optional per-step agent overrides, for example a narrower tool set."),
  })
  .superRefine((step, ctx) => {
    if (step.on_error === "retry" && !step.retry) {
      ctx.addIssue({ code: "custom", path: ["retry"], message: "Steps with on_error='retry' must set retry.max_attempts >= 1." });
    }
  });

const stepsSchema = z
  .array(stepSchema)
  .min(1)
  .describe("Steps run in order. Only sequential 'step' entries are supported (no parallel groups).");

const visibilitySchema = z.enum(["private", "team", "global"]);
const teamsSchema = z.array(z.string()).describe("Team slugs. Required when visibility is 'team'.");

function requireTeamsForTeamVisibility(visibility: string | undefined, teams: string[] | undefined): void {
  if (visibility === "team" && (!teams || teams.length === 0)) {
    throw new WorkflowToolError("Pass at least one team in shared_with_teams when visibility is 'team'.");
  }
}

function dropNullish<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null));
}

function dumpSteps(steps: z.infer<typeof stepsSchema>): unknown[] {
  return steps.map((step) => dropNullish(step));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

/** Build a Workflows MCP server bound to one caller. Create one per request. */
export function createWorkflowsMcpServer(ctx: WorkflowsMcpContext): McpServer {
  const server = new McpServer({ name: "caipe-workflows", version: "1.0.0" });
  const call = (handler: RouteHandler, spec: RouteCall) => callRoute(ctx, handler, spec);
  const byId = (id: string) => ({ params: Promise.resolve({ id }) });

  // -- definitions ----------------------------------------------------------

  server.registerTool(
    "list_workflows",
    { description: "List the workflows you can see (your own, shared with your teams, and global).", annotations: READ_ONLY },
    () => respond(() => call(configsRoute.GET as RouteHandler, { method: "GET", path: "/api/workflow-configs" })),
  );

  server.registerTool(
    "get_workflow",
    {
      description: "Fetch one workflow definition, including its steps, by workflow_id.",
      inputSchema: { workflow_id: workflowId },
      annotations: READ_ONLY,
    },
    ({ workflow_id }) =>
      respond(() => call(configsRoute.GET as RouteHandler, { method: "GET", path: "/api/workflow-configs", search: { id: workflow_id } })),
  );

  server.registerTool(
    "create_workflow",
    {
      description:
        "Create a workflow: an ordered list of steps, each sent to a dynamic agent. " +
        "Use check_workflow_agent_access first when sharing with teams or globally. Returns the new id.",
      inputSchema: {
        name: z.string().min(1).describe("Workflow name."),
        steps: stepsSchema,
        description: z.string().optional().describe("What the workflow does."),
        visibility: visibilitySchema.default("private").describe("Who can run it: 'private' (you), 'team', or 'global'."),
        shared_with_teams: teamsSchema.optional(),
      },
      annotations: WRITE,
    },
    ({ name, steps, description, visibility, shared_with_teams }) =>
      respond(async () => {
        requireTeamsForTeamVisibility(visibility, shared_with_teams);
        const body = dropNullish({
          name,
          description,
          steps: dumpSteps(steps),
          visibility,
          shared_with_teams: visibility === "team" ? shared_with_teams : undefined,
        });
        return call(configsRoute.POST as RouteHandler, { method: "POST", path: "/api/workflow-configs", body });
      }),
  );

  server.registerTool(
    "update_workflow",
    {
      description:
        "Change a workflow you own. Pass only the fields to change; `steps` replaces the whole list. " +
        "Workflows defined in the deployment's config files are read-only.",
      inputSchema: {
        workflow_id: workflowId,
        name: z.string().min(1).optional().describe("New name."),
        description: z.string().optional().describe("New description. Pass an empty string to clear it."),
        steps: stepsSchema.optional(),
        visibility: visibilitySchema.optional().describe("New visibility."),
        shared_with_teams: teamsSchema.optional(),
      },
      annotations: WRITE,
    },
    ({ workflow_id, ...changes }) =>
      respond(async () => {
        const body = dropNullish({ ...changes, steps: changes.steps ? dumpSteps(changes.steps) : undefined });
        if (Object.keys(body).length === 0) throw new WorkflowToolError("Pass at least one field to change.");
        requireTeamsForTeamVisibility(changes.visibility, changes.shared_with_teams);
        return call(configsRoute.PUT as RouteHandler, { method: "PUT", path: "/api/workflow-configs", search: { id: workflow_id }, body });
      }),
  );

  server.registerTool(
    "delete_workflow",
    {
      description: "Permanently delete a workflow you own. Its past runs are not deleted. Config-file workflows cannot be deleted.",
      inputSchema: { workflow_id: workflowId },
      annotations: DESTRUCTIVE,
    },
    ({ workflow_id }) =>
      respond(() => call(configsRoute.DELETE as RouteHandler, { method: "DELETE", path: "/api/workflow-configs", search: { id: workflow_id } })),
  );

  server.registerTool(
    "check_workflow_agent_access",
    {
      description:
        "Before sharing a workflow, check whether the people it is shared with can use every agent in its steps. " +
        "Returns the gaps (agent, and team where relevant); an empty list means no gaps.",
      inputSchema: {
        steps: stepsSchema,
        visibility: visibilitySchema.default("private").describe("Visibility you plan to use."),
        shared_with_teams: teamsSchema.optional(),
      },
      annotations: READ_ONLY,
    },
    ({ steps, visibility, shared_with_teams }) =>
      respond(() =>
        call(checkAccessRoute.POST as RouteHandler, {
          method: "POST",
          path: "/api/workflow-configs/check-agent-access",
          body: { steps: dumpSteps(steps), visibility, shared_with_teams: shared_with_teams ?? [] },
        }),
      ),
  );

  // -- runs -----------------------------------------------------------------

  server.registerTool(
    "start_workflow_run",
    {
      description:
        "Start a run of a workflow as the authenticated caller. Returns {run_id, status}. " +
        "The run continues in the background: poll get_workflow_run for progress.",
      inputSchema: {
        workflow_id: workflowId,
        user_context: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe("Optional input for the run (free text or a JSON object), made available to the steps."),
        trigger_info: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional small JSON object describing why the run started, for example {'source': 'ticket-123'}. The caller's identity is added by the API."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ workflow_id, user_context, trigger_info }) =>
      respond(() =>
        call(runsRoute.POST as RouteHandler, {
          method: "POST",
          path: "/api/workflow-runs",
          body: dropNullish({ workflow_config_id: workflow_id, user_context, trigger_info }),
        }),
      ),
  );

  server.registerTool(
    "list_workflow_runs",
    {
      description: "List workflow runs you can see. Pass workflow_id to narrow to one workflow.",
      inputSchema: { workflow_id: z.string().optional().describe("Only runs of this workflow. Omit for your recent runs.") },
      annotations: READ_ONLY,
    },
    ({ workflow_id }) =>
      respond(() =>
        call(runsRoute.GET as RouteHandler, {
          method: "GET",
          path: "/api/workflow-runs",
          search: workflow_id ? { workflow_config_id: workflow_id } : undefined,
        }),
      ),
  );

  server.registerTool(
    "get_workflow_run",
    {
      description:
        "Get a run's status and per-step results. A step that needs input shows a waiting status: " +
        "answer it with resume_workflow_run. Set include_events for the full event log.",
      inputSchema: {
        run_id: runId,
        include_events: z.boolean().default(false).describe("Include the full per-step event log. It can be large, so it is off by default."),
      },
      annotations: READ_ONLY,
    },
    ({ run_id, include_events }) =>
      respond(async () => {
        const run = await call(runRoute.GET as RouteHandler, { method: "GET", path: `/api/workflow-runs/${encodeURIComponent(run_id)}`, context: byId(run_id) });
        if (!include_events && run && typeof run === "object") {
          return Object.fromEntries(Object.entries(run).filter(([key]) => key !== "events"));
        }
        return run;
      }),
  );

  server.registerTool(
    "cancel_workflow_run",
    {
      description: "Cancel a run that is in progress. Steps that already finished are kept.",
      inputSchema: { run_id: runId },
      annotations: DESTRUCTIVE,
    },
    ({ run_id }) =>
      respond(() =>
        call(cancelRoute.POST as RouteHandler, { method: "POST", path: `/api/workflow-runs/${encodeURIComponent(run_id)}/cancel`, context: byId(run_id) }),
      ),
  );

  server.registerTool(
    "resume_workflow_run",
    {
      description: "Provide the input a paused run is waiting for (human-in-the-loop) and continue it.",
      inputSchema: {
        run_id: runId.describe("The run that is waiting for input."),
        step_index: z.number().int().min(0).describe("Index of the step that asked for input (see get_workflow_run)."),
        resume_data: z
          .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
          .describe("The input requested by the step, usually the answers to its form."),
      },
      annotations: WRITE,
    },
    ({ run_id, step_index, resume_data }) =>
      respond(() =>
        call(resumeRoute.POST as RouteHandler, {
          method: "POST",
          path: `/api/workflow-runs/${encodeURIComponent(run_id)}/resume`,
          body: { step_index, resume_data },
          context: byId(run_id),
        }),
      ),
  );

  server.registerTool(
    "share_workflow_run",
    {
      description: "Change who can view a run you own: private, workspace or admin.",
      inputSchema: {
        run_id: runId.describe("The run to change. Only its owner can."),
        shared_with: z.enum(["private", "workspace", "admin"]).describe("Who else can view the run: nobody, the workspace, or admins."),
      },
      annotations: WRITE,
    },
    ({ run_id, shared_with }) =>
      respond(() =>
        call(runRoute.PATCH as RouteHandler, {
          method: "PATCH",
          path: `/api/workflow-runs/${encodeURIComponent(run_id)}`,
          body: { shared_with },
          context: byId(run_id),
        }),
      ),
  );

  server.registerTool(
    "delete_workflow_run",
    {
      description: "Permanently delete a run and its stored files.",
      inputSchema: { run_id: runId },
      annotations: DESTRUCTIVE,
    },
    ({ run_id }) =>
      respond(() =>
        call(runRoute.DELETE as RouteHandler, { method: "DELETE", path: `/api/workflow-runs/${encodeURIComponent(run_id)}`, context: byId(run_id) }),
      ),
  );

  return server;
}
