import { createHash, randomUUID } from "crypto";

import { NextRequest } from "next/server";

import { ApiError } from "@/lib/api-error";
import {
  BUILTIN_LOCKED_MESSAGE,
  canMutateBuiltinSkill,
} from "@/lib/builtin-skill-policy";
import { getCollection } from "@/lib/mongodb";
import {
  requireAgentPermission,
  requireSkillPermission,
  type ResourceAuthzSession,
} from "@/lib/rbac/resource-authz";
import { requireWorkflowConfigWriteAccess } from "@/lib/rbac/workflow-config-rebac";

export type PlatformResourceKind = "agent" | "skill" | "workflow" | "schedule";
export type PlatformChangeOperation = "create" | "update";
export type PlatformChangeStatus = "pending" | "applying" | "applied" | "cancelled" | "expired";

export interface PlatformActor {
  subject: string;
  email: string;
  role?: string;
}

export interface PlatformChangeDocument {
  _id: string;
  kind: PlatformResourceKind;
  operation: PlatformChangeOperation;
  resource_id: string | null;
  changes: Record<string, unknown>;
  reason: string;
  before: Record<string, unknown> | null;
  base_revision: string | null;
  status: PlatformChangeStatus;
  actor: PlatformActor;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  applied_at?: Date;
  result?: unknown;
}

type SessionLike = ResourceAuthzSession & {
  accessToken?: unknown;
  isServiceAccount?: boolean;
};

interface StringIdResource extends Record<string, unknown> {
  _id: string;
}

interface SkillResource extends Record<string, unknown> {
  id: string;
  is_system: boolean;
}

const CHANGE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CHANGE_BYTES = 6 * 1024 * 1024;

export function assertPlatformOperationSupported(
  kind: PlatformResourceKind,
  operation: PlatformChangeOperation,
): void {
  if (kind === "agent" && operation === "create") {
    throw new ApiError(
      "Agent creation is not available through the platform MCP because owner-team selection is an authority change. Create the agent in the admin UI, then use the MCP for content and runtime edits.",
      400,
    );
  }
}

const MUTABLE_FIELDS: Record<PlatformResourceKind, ReadonlySet<string>> = {
  agent: new Set([
    "name",
    "description",
    "system_prompt",
    "allowed_tools",
    "builtin_tools",
    "model",
    "subagents",
    "skills",
    "datasource_ids",
    "rag_collection_ids",
    "ui",
    "features",
    "interrupt_on",
    "enabled",
    "last_review",
  ]),
  skill: new Set([
    "name",
    "description",
    "category",
    "tasks",
    "metadata",
    "is_quick_start",
    "difficulty",
    "thumbnail",
    "input_form",
    "skill_content",
    "ancillary_files",
  ]),
  workflow: new Set(["name", "description", "steps"]),
  schedule: new Set([
    "agent_id",
    "edit_agent_id",
    "enabled",
    "cron",
    "tz",
    "message_template",
    "title",
    "attributes",
  ]),
};

function stableValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .map((key) => [key, stableValue(input[key])]),
    );
  }
  return value;
}

function mutableSnapshot(
  kind: PlatformResourceKind,
  resource: Record<string, unknown>,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const field of MUTABLE_FIELDS[kind]) {
    if (resource[field] !== undefined) snapshot[field] = resource[field];
  }
  return snapshot;
}

export function platformResourceView(
  kind: PlatformResourceKind,
  resource: Record<string, unknown>,
): Record<string, unknown> {
  return mutableSnapshot(kind, resource);
}

export function platformResourceRevision(
  kind: PlatformResourceKind,
  resource: Record<string, unknown>,
): string {
  const canonical = JSON.stringify(stableValue(mutableSnapshot(kind, resource)));
  return createHash("sha256").update(canonical).digest("hex");
}

export function validatePlatformChangeInput(input: {
  kind: unknown;
  operation: unknown;
  resource_id?: unknown;
  changes: unknown;
  reason: unknown;
}): {
  kind: PlatformResourceKind;
  operation: PlatformChangeOperation;
  resourceId: string | null;
  changes: Record<string, unknown>;
  reason: string;
} {
  if (!(["agent", "skill", "workflow", "schedule"] as unknown[]).includes(input.kind)) {
    throw new ApiError("kind must be agent, skill, workflow, or schedule", 400);
  }
  if (input.operation !== "create" && input.operation !== "update") {
    throw new ApiError("operation must be create or update", 400);
  }
  if (!input.changes || typeof input.changes !== "object" || Array.isArray(input.changes)) {
    throw new ApiError("changes must be a JSON object", 400);
  }
  const changes = input.changes as Record<string, unknown>;
  if (Object.keys(changes).length === 0) {
    throw new ApiError("changes must include at least one field", 400);
  }
  const kind = input.kind as PlatformResourceKind;
  assertPlatformOperationSupported(kind, input.operation);
  const unsupported = Object.keys(changes).filter((field) => !MUTABLE_FIELDS[kind].has(field));
  if (unsupported.length > 0) {
    throw new ApiError(
      `Unsupported ${kind} field(s): ${unsupported.join(", ")}. Ownership, visibility, sharing, credentials, and deletion are not available through the platform MCP.`,
      400,
    );
  }
  if (JSON.stringify(changes).length > MAX_CHANGE_BYTES) {
    throw new ApiError("Change payload exceeds the 6 MiB limit", 413);
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason || reason.length > 2000) {
    throw new ApiError("reason must be between 1 and 2000 characters", 400);
  }
  const resourceId = typeof input.resource_id === "string" && input.resource_id.trim()
    ? input.resource_id.trim()
    : null;
  if (input.operation === "update" && !resourceId) {
    throw new ApiError("resource_id is required for update proposals", 400);
  }
  if (input.operation === "create" && resourceId) {
    throw new ApiError("resource_id must be omitted for create proposals", 400);
  }
  return {
    kind,
    operation: input.operation,
    resourceId,
    changes,
    reason,
  };
}

export function platformActor(
  user: { email: string; role?: string },
  session: SessionLike,
): PlatformActor {
  if (session.isServiceAccount === true) {
    throw new ApiError(
      "Platform changes require a human user identity. Service-account execution may continue using other tools, but cannot approve control-plane edits.",
      403,
    );
  }
  const subject = typeof session.sub === "string" ? session.sub.trim() : "";
  if (!subject) throw new ApiError("Authenticated user subject is required", 401);
  return { subject, email: user.email, role: user.role };
}

export async function getWritablePlatformResource(
  kind: PlatformResourceKind,
  resourceId: string,
  user: { email: string; role?: string },
  session: SessionLike,
): Promise<Record<string, unknown>> {
  if (kind === "agent") {
    const collection = await getCollection<StringIdResource>("dynamic_agents");
    const resource = await collection.findOne({ _id: resourceId });
    if (!resource) throw new ApiError("Agent not found", 404);
    await requireAgentPermission(session, resourceId, "write");
    if (resource.config_driven === true) {
      throw new ApiError("Config-driven agents must be edited in deployment configuration", 403);
    }
    return resource;
  }
  if (kind === "skill") {
    const collection = await getCollection<SkillResource>("agent_skills");
    const resource = await collection.findOne({ id: resourceId });
    if (!resource) throw new ApiError("Skill not found", 404);
    await requireSkillPermission(session, resourceId, "write");
    if (!canMutateBuiltinSkill(resource)) {
      throw new ApiError(BUILTIN_LOCKED_MESSAGE, 403);
    }
    return resource;
  }
  if (kind === "workflow") {
    const collection = await getCollection<StringIdResource>("workflow_configs");
    const resource = await collection.findOne({ _id: resourceId });
    if (!resource) throw new ApiError("Workflow not found", 404);
    if (resource.config_driven === true) {
      throw new ApiError("Config-driven workflows must be edited in deployment configuration", 403);
    }
    if (user.role !== "admin") {
      await requireWorkflowConfigWriteAccess(
        session,
        {
          _id: resourceId,
          owner_id: String(resource.owner_id ?? ""),
          visibility: resource.visibility as "private" | "team" | "global",
          shared_with_teams: resource.shared_with_teams as string[] | undefined,
        },
        user.email,
      );
    }
    return resource;
  }

  const collection = await getCollection<Record<string, unknown>>("schedules");
  const resource = await collection.findOne({
    schedule_id: resourceId,
    owner_user_id: user.email,
  });
  if (!resource) throw new ApiError("Schedule not found", 404);
  return resource;
}

function proposalView(change: PlatformChangeDocument): Record<string, unknown> {
  const after = change.before ? { ...mutableSnapshot(change.kind, change.before), ...change.changes } : change.changes;
  const diff = Object.fromEntries(
    Object.entries(change.changes).map(([field, value]) => [
      field,
      { before: change.before?.[field] ?? null, after: value },
    ]),
  );
  return {
    change_id: change._id,
    kind: change.kind,
    operation: change.operation,
    resource_id: change.resource_id,
    reason: change.reason,
    status: change.status,
    before: change.before,
    after,
    diff,
    actor: change.actor,
    created_at: change.created_at,
    expires_at: change.expires_at,
    applied_at: change.applied_at ?? null,
    result: change.result ?? null,
  };
}

export async function createPlatformChange(input: {
  kind: PlatformResourceKind;
  operation: PlatformChangeOperation;
  resourceId: string | null;
  changes: Record<string, unknown>;
  reason: string;
  actor: PlatformActor;
  user: { email: string; role?: string };
  session: SessionLike;
}): Promise<Record<string, unknown>> {
  const current = input.operation === "update"
    ? await getWritablePlatformResource(input.kind, input.resourceId!, input.user, input.session)
    : null;
  const before = current ? mutableSnapshot(input.kind, current) : null;
  const now = new Date();
  const document: PlatformChangeDocument = {
    _id: `chg_${randomUUID()}`,
    kind: input.kind,
    operation: input.operation,
    resource_id: input.resourceId,
    changes: input.changes,
    reason: input.reason,
    before,
    base_revision: current ? platformResourceRevision(input.kind, current) : null,
    status: "pending",
    actor: input.actor,
    created_at: now,
    updated_at: now,
    expires_at: new Date(now.getTime() + CHANGE_TTL_MS),
  };
  const collection = await getCollection<PlatformChangeDocument>("platform_changes");
  await collection.insertOne(document);
  return proposalView(document);
}

export async function getOwnedPlatformChange(
  changeId: string,
  actor: PlatformActor,
): Promise<PlatformChangeDocument> {
  const collection = await getCollection<PlatformChangeDocument>("platform_changes");
  const change = await collection.findOne({ _id: changeId, "actor.subject": actor.subject });
  if (!change) throw new ApiError("Platform change not found", 404);
  if (change.status === "pending" && new Date(change.expires_at).getTime() <= Date.now()) {
    await collection.updateOne(
      { _id: changeId, status: "pending" },
      { $set: { status: "expired", updated_at: new Date() } },
    );
    change.status = "expired";
  }
  return change;
}

export async function readPlatformChange(
  changeId: string,
  actor: PlatformActor,
): Promise<Record<string, unknown>> {
  return proposalView(await getOwnedPlatformChange(changeId, actor));
}

function forwardedHeaders(request: NextRequest): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const name of ["authorization", "cookie", "x-client-source", "traceparent"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function canonicalMutation(
  request: NextRequest,
  change: PlatformChangeDocument,
  session: SessionLike,
): Promise<unknown> {
  const headers = forwardedHeaders(request);
  const method = change.operation === "create" ? "POST" : "PUT";
  const id = change.resource_id ? encodeURIComponent(change.resource_id) : null;
  let response: Response;

  if (change.kind === "agent") {
    const route = await import("@/app/api/dynamic-agents/route");
    const url = new URL(`/api/dynamic-agents${id ? `?id=${id}` : ""}`, request.url);
    const mutationRequest = new NextRequest(url, {
      method,
      headers,
      body: JSON.stringify(change.changes),
    });
    response = change.operation === "create"
      ? await route.POST(mutationRequest, undefined)
      : await route.PUT(mutationRequest, undefined);
  } else if (change.kind === "skill") {
    const route = await import("@/app/api/skills/configs/route");
    const url = new URL(`/api/skills/configs${id ? `?id=${id}` : ""}`, request.url);
    const mutationRequest = new NextRequest(url, {
      method,
      headers,
      body: JSON.stringify(change.changes),
    });
    response = change.operation === "create"
      ? await route.POST(mutationRequest, undefined)
      : await route.PUT(mutationRequest, undefined);
  } else if (change.kind === "workflow") {
    const route = await import("@/app/api/workflow-configs/route");
    const url = new URL(`/api/workflow-configs${id ? `?id=${id}` : ""}`, request.url);
    const mutationRequest = new NextRequest(url, {
      method,
      headers,
      body: JSON.stringify(change.changes),
    });
    response = change.operation === "create"
      ? await route.POST(mutationRequest, undefined)
      : await route.PUT(mutationRequest, undefined);
  } else if (change.operation === "update") {
    const route = await import("@/app/api/schedules/[id]/route");
    const url = new URL(`/api/schedules/${id}`, request.url);
    response = await route.PATCH(
      new NextRequest(url, { method: "PATCH", headers, body: JSON.stringify(change.changes) }),
      { params: Promise.resolve({ id: change.resource_id! }) },
    );
  } else {
    const accessToken = typeof session.accessToken === "string" ? session.accessToken.trim() : "";
    if (!accessToken) throw new ApiError("Your session has no access token. Sign in again.", 401);
    const schedulerUrl = (
      process.env.SCHEDULER_URL ||
      process.env.CAIPE_SCHEDULER_URL ||
      "http://caipe-scheduler:8080"
    ).replace(/\/+$/, "");
    const schedulerHeaders: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };
    const serviceToken = process.env.SCHEDULER_SERVICE_TOKEN || process.env.CAIPE_SCHEDULER_SERVICE_TOKEN;
    if (serviceToken) schedulerHeaders["X-Scheduler-Token"] = serviceToken;
    response = await fetch(`${schedulerUrl}/v1/schedules`, {
      method: "POST",
      headers: schedulerHeaders,
      body: JSON.stringify(change.changes),
      cache: "no-store",
    });
  }

  const body = await responseBody(response);
  if (!response.ok) {
    const detail = body && typeof body === "object"
      ? (body as { error?: unknown; message?: unknown; detail?: unknown }).error ??
        (body as { message?: unknown }).message ??
        (body as { detail?: unknown }).detail
      : body;
    throw new ApiError(String(detail || `Platform mutation returned ${response.status}`), response.status);
  }
  if (body && typeof body === "object" && "data" in body) {
    return (body as { data: unknown }).data;
  }
  return body;
}

export async function applyPlatformChange(input: {
  changeId: string;
  actor: PlatformActor;
  user: { email: string; role?: string };
  session: SessionLike;
  request: NextRequest;
}): Promise<Record<string, unknown>> {
  const collection = await getCollection<PlatformChangeDocument>("platform_changes");
  const change = await getOwnedPlatformChange(input.changeId, input.actor);
  if (change.status !== "pending") {
    if (change.status === "applied") return proposalView(change);
    throw new ApiError(`Platform change is ${change.status} and cannot be applied`, 409);
  }

  if (change.operation === "update") {
    const current = await getWritablePlatformResource(
      change.kind,
      change.resource_id!,
      input.user,
      input.session,
    );
    if (platformResourceRevision(change.kind, current) !== change.base_revision) {
      throw new ApiError(
        "The resource changed after this proposal was created. Inspect it again and create a new proposal.",
        409,
      );
    }
  }

  const claim = await collection.updateOne(
    { _id: change._id, "actor.subject": input.actor.subject, status: "pending" },
    { $set: { status: "applying", updated_at: new Date() } },
  );
  if (claim.modifiedCount !== 1) {
    throw new ApiError("Platform change is already being applied", 409);
  }

  try {
    const result = await canonicalMutation(input.request, change, input.session);
    const appliedAt = new Date();
    await collection.updateOne(
      { _id: change._id, status: "applying" },
      { $set: { status: "applied", result, applied_at: appliedAt, updated_at: appliedAt } },
    );
    return proposalView({ ...change, status: "applied", result, applied_at: appliedAt, updated_at: appliedAt });
  } catch (error) {
    await collection.updateOne(
      { _id: change._id, status: "applying" },
      { $set: { status: "pending", updated_at: new Date() } },
    );
    throw error;
  }
}

export async function cancelPlatformChange(
  changeId: string,
  actor: PlatformActor,
): Promise<Record<string, unknown>> {
  const collection = await getCollection<PlatformChangeDocument>("platform_changes");
  const now = new Date();
  const result = await collection.findOneAndUpdate(
    { _id: changeId, "actor.subject": actor.subject, status: "pending" },
    { $set: { status: "cancelled", updated_at: now } },
    { returnDocument: "after" },
  );
  if (!result) throw new ApiError("Pending platform change not found", 404);
  return proposalView(result);
}
