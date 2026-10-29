// CAS policy adapter: decisions and grants use the shared BFF transport.

import type {
  Action,
  AuthorizeRequest,
  AuthorizeResult,
  Grantee,
  GrantIntent,
  Resource,
  ResourceType,
  Subject,
} from "../contract";
import type { ListObjectsResult, PolicyAdmin, PolicyEngine } from "../engine";
import { BoundedTtlCache } from "../cache";
import { getReasonMeta } from "../reasons";
import { registeredResourceGate, requireRegisteredResource } from "../resource-policy";
import { openFgaRelation, openFgaCheckRelation } from "@/lib/rbac/tuple-builders";
import { openFgaResourceObject, parseOpenFgaObject } from "@/lib/rbac/openfga-resource-ids";
import { APP_NAME_PATTERN, isAppResource, permissionObject } from "../resource-contract";
import { isOpenFgaReconciliationEnabled } from "@/lib/rbac/openfga";
import { HttpAuthzError } from "../errors";

import {
  getCachedOpenFgaStoreId,
  getOpenFgaStoreId,
  OPENFGA_READ_TIMEOUT_MS,
  requestOpenFga,
  resetOpenFgaStoreIdCacheForTests,
} from "./openfga-client";

// ─── Transport ────────────────────────────────────────────────────────────────

const BATCH_CONCURRENCY = 10;

async function fgaCheck(
  storeId: string, user: string, relation: string, object: string,
  options: { consistency?: "HIGHER_CONSISTENCY"; signal?: AbortSignal; contextualTuples?: FgaTuple[] } = {},
): Promise<boolean> {
  const res = await requestOpenFga(`/stores/${storeId}/check`, {
    method: "POST",
    body: JSON.stringify({
      tuple_key: { user, relation, object },
      ...(options.contextualTuples ? { contextual_tuples: { tuple_keys: options.contextualTuples } } : {}),
      ...(options.consistency ? { consistency: options.consistency } : {}),
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (res.status === 404) {
    throw new Error("OpenFGA store not found (404)");
  }
  if (!res.ok) throw new Error(`OpenFGA check failed: ${res.status}`);
  const body = (await res.json()) as { allowed?: boolean };
  if (typeof body.allowed !== "boolean") throw new Error("OpenFGA check returned an invalid decision");
  return body.allowed;
}

async function fgaListObjects(
  storeId: string,
  user: string,
  relation: string,
  type: string,
): Promise<string[]> {
  const res = await requestOpenFga(`/stores/${storeId}/list-objects`, {
    method: "POST",
    body: JSON.stringify({ user, relation, type }),
  });
  if (res.status === 404) {
    throw new Error("OpenFGA store not found (404)");
  }
  if (!res.ok) throw new Error(`OpenFGA list-objects failed: ${res.status}`);
  const body = (await res.json()) as { objects?: string[] };
  return body.objects ?? [];
}

// ─── Circuit breaker (per replica) ───────────────────────────────────────────

type CircuitState = "closed" | "open" | "half_open";

const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_DURATION_MS = 30_000;

let circuitState: CircuitState = "closed";
let failureCount = 0;
let openSince = 0;
let probeInFlight = false;

/** Synchronous gate. In half_open, admits exactly one probe at a time. */
function circuitAllows(): boolean {
  if (circuitState === "closed") return true;
  if (circuitState === "open") {
    if (Date.now() - openSince < CIRCUIT_OPEN_DURATION_MS) return false; // still cooling down
    circuitState = "half_open"; // cooldown elapsed — fall through to probe handling
  }
  // half_open: admit exactly one probe at a time
  if (probeInFlight) return false;
  probeInFlight = true;
  return true;
}

function recordSuccess(): void {
  failureCount = 0;
  circuitState = "closed";
  probeInFlight = false;
}

function recordFailure(): void {
  probeInFlight = false;
  if (circuitState === "half_open") {
    circuitState = "open";
    openSince = Date.now();
    return;
  }
  failureCount++;
  if (failureCount >= CIRCUIT_FAILURE_THRESHOLD) {
    circuitState = "open";
    openSince = Date.now();
  }
}

/**
 * Drop cached authorization decisions after relationship graph mutations —
 * both the per-decision cache and the list-objects (reverse lookup) cache.
 * This is the ONLY place that should ever clear either cache after a
 * mutation; a caller reaching for `decisionCache.clear()` directly is
 * exactly how the two caches drift out of sync with each other.
 */
export function invalidateDecisionCache(): void {
  decisionCache.clear();
  listObjectsCache.clear();
}

/** Test-only reset of breaker + store-id state. */
export function __resetAdapterStateForTests(): void {
  circuitState = "closed";
  failureCount = 0;
  openSince = 0;
  probeInFlight = false;
  resetOpenFgaStoreIdCacheForTests();
  cacheHits = 0;
  cacheMisses = 0;
  decisionCache.clear();
  listObjectsCache.clear();
}

// ─── Decision cache ───────────────────────────────────────────────────────────

const READ_TTL_MS = Number(process.env.AUTHZ_DECISION_CACHE_TTL_MS ?? 15_000);
const WRITE_TTL_MS = Number(process.env.AUTHZ_DECISION_CACHE_WRITE_TTL_MS ?? 2_000);
const WRITE_ACTIONS = new Set<Action>(["write", "create", "manage", "delete", "ingest"]);

const decisionCache = new BoundedTtlCache<AuthorizeResult>(10_000, READ_TTL_MS);
// Separate from decisionCache: a listObjects result is a whole accessible set
// per (subject, action, resourceType), not one subject/resource/action outcome.
const listObjectsCache = new BoundedTtlCache<Set<string>>(1_000, READ_TTL_MS);

let cacheHits = 0;
let cacheMisses = 0;

function cacheKey(subject: Subject, resource: Resource, action: Action, context?: Record<string, unknown>): string {
  const contextKey = context ? `|ctx:${stableContextKey(context)}` : "";
  return `${subject.type}:${subject.id}|${resource.type}:${resource.id}|${action}${contextKey}`;
}

function stableContextKey(context: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(context)
      .sort()
      .map((key) => [key, context[key]]),
  );
}

/**
 * Live, per-replica adapter snapshot for the CAS health panel. Reflects only
 * the replica that serves the request (circuit + cache are module-local).
 */
export interface EngineStats {
  circuitState: CircuitState;
  cacheSize: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRatio: number;
}

export function getEngineStats(): EngineStats {
  const total = cacheHits + cacheMisses;
  return {
    circuitState,
    cacheSize: decisionCache.size + listObjectsCache.size,
    cacheHits,
    cacheMisses,
    cacheHitRatio: total > 0 ? cacheHits / total : 0,
  };
}

function ttlForAction(action: Action): number {
  return WRITE_ACTIONS.has(action) ? WRITE_TTL_MS : READ_TTL_MS;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function boundedParallel<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const item = items[index++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

function allow(): AuthorizeResult {
  return { decision: "ALLOW", reason: "OK", retriable: getReasonMeta("OK").retriable, ttl_seconds: Math.floor(READ_TTL_MS / 1000), via: "tuple" };
}

function deny(reason: AuthorizeResult["reason"] = "NO_CAPABILITY"): AuthorizeResult {
  return { decision: "DENY", reason, retriable: getReasonMeta(reason).retriable };
}

async function runCheck(req: AuthorizeRequest, fresh = false, deadline?: AbortSignal): Promise<AuthorizeResult> {
  const signal = deadline ?? (fresh ? AbortSignal.timeout(OPENFGA_READ_TIMEOUT_MS) : undefined);
  if (isAppResource(req.resource.type)) {
    const resourceState = await registeredResourceGate(req.resource, signal, req.action);
    if (resourceState) return resourceState;
  }
  if (deadline?.aborted) return deny("AUTHZ_UNAVAILABLE");
  if (!circuitAllows()) return deny("AUTHZ_UNAVAILABLE");
  const halfOpenProbe = circuitState === "half_open";

  const mapped = mapFgaCheck(req.resource, req.action);
  const relation = mapped.relation;
  const user = `${req.subject.type}:${req.subject.id}`;
  const object = mapped.object;

  try {
    // Start before discovery so it consumes the same execution-check budget.
    signal?.throwIfAborted();
    const storeId = await getOpenFgaStoreId();
    signal?.throwIfAborted();
    const allowed = await fgaCheck(storeId, user, relation, object,
      { ...(fresh ? { consistency: "HIGHER_CONSISTENCY" as const, signal } : {}), contextualTuples: mapped.contextualTuples });
    signal?.throwIfAborted();
    recordSuccess();
    // Do not publish an allow after another replica disabled the integration
    // or changed the lifecycle state while the graph check was in flight.
    if (isAppResource(req.resource.type)) {
      const latestState = await registeredResourceGate(req.resource, signal, req.action);
      if (latestState) return latestState;
    }
    const result = allowed ? allow() : deny("NO_CAPABILITY");
    return fresh ? { ...result, ttl_seconds: 0 } : result;
  } catch (err) {
    // Exhausting a caller's total budget is not a failed dependency probe.
    // Release a cancelled half-open probe without poisoning other requests.
    if (deadline?.aborted) {
      if (halfOpenProbe && circuitState === "half_open") probeInFlight = false;
    } else recordFailure();
    console.warn("[cas/openfga] check error:", err instanceof Error ? err.message : String(err));
    return deny("AUTHZ_UNAVAILABLE");
  }
}

/** Delegation only narrows existing graph authority; no product-policy override. */
export function checkDelegationPermission(req: AuthorizeRequest, signal: AbortSignal): Promise<AuthorizeResult> {
  return runCheck(req, true, signal);
}

/** Private gateway adapter: agents are allowed here, never as public API subjects. */
export async function checkGatewayPermission(
  subject: Subject | { type: "agent"; id: string },
  relation: "can_call" | "can_use" | "can_invoke" | "can_search",
  object: string,
  signal: AbortSignal,
): Promise<AuthorizeResult> {
  if (!circuitAllows()) return deny("AUTHZ_UNAVAILABLE");
  try {
    const storeId = await getOpenFgaStoreId();
    signal.throwIfAborted();
    const allowed = await fgaCheck(storeId, `${subject.type}:${subject.id}`, relation, object,
      { consistency: "HIGHER_CONSISTENCY", signal });
    recordSuccess();
    return { ...(allowed ? allow() : deny()), ttl_seconds: 0 };
  } catch (err) {
    recordFailure();
    console.warn("[cas/openfga] Gateway check unavailable:", err instanceof Error ? err.message : String(err));
    return deny("AUTHZ_UNAVAILABLE");
  }
}

async function runListObjects(subject: Subject, action: Action, resourceType: ResourceType): Promise<ListObjectsResult> {
  if (!circuitAllows()) return { ids: new Set(), reason: "AUTHZ_UNAVAILABLE" };

  const relation = openFgaCheckRelation(action);
  const user = `${subject.type}:${subject.id}`;

  try {
    const storeId = await getOpenFgaStoreId();
    const objects = await fgaListObjects(storeId, user, relation, resourceType);
    recordSuccess();
    return { ids: new Set(objects.map(parseOpenFgaObject)), reason: "OK" };
  } catch (err) {
    recordFailure();
    console.warn("[cas/openfga] list-objects error:", err instanceof Error ? err.message : String(err));
    return { ids: new Set(), reason: "AUTHZ_UNAVAILABLE" };
  }
}

async function listObjectsWithCache(
  subject: Subject,
  action: Action,
  resourceType: ResourceType,
): Promise<ListObjectsResult> {
  const key = `${subject.type}:${subject.id}|${resourceType}|${action}`;
  const cached = listObjectsCache.get(key);
  if (cached) {
    cacheHits++;
    return { ids: cached, reason: "OK" };
  }
  cacheMisses++;

  const result = await runListObjects(subject, action, resourceType);
  // Only cache a definitive result — never cache a PDP outage as "no access".
  if (result.reason !== "AUTHZ_UNAVAILABLE") {
    listObjectsCache.set(key, result.ids, ttlForAction(action));
  }
  return result;
}

async function checkWithCache(req: AuthorizeRequest): Promise<AuthorizeResult> {
  if (isAppResource(req.resource.type)) return runCheck(req, true);
  const key = cacheKey(req.subject, req.resource, req.action, req.context);
  const cached = decisionCache.get(key);
  if (cached) {
    cacheHits++;
    return cached;
  }
  cacheMisses++;

  const result = await runCheck(req);
  // Only cache definitive outcomes — never cache transient unavailability.
  if (result.reason !== "AUTHZ_UNAVAILABLE") {
    decisionCache.set(key, result, ttlForAction(req.action));
  }
  return result;
}

// ─── PolicyEngine ─────────────────────────────────────────────────────────────

export function createOpenFgaEngine(): PolicyEngine {
  return {
    check(req: AuthorizeRequest): Promise<AuthorizeResult> {
      // A single agent-use check enforces execution. Never reuse an allow/deny
      // from a picker batch or another request, even on this replica.
      if (req.resource.type === "agent" && req.action === "use") {
        cacheMisses++;
        return runCheck(req, true);
      }
      return checkWithCache(req);
    },

    async batchCheck(
      subject: Subject,
      action: Action,
      resourceType: ResourceType,
      ids: string[],
    ): Promise<Map<string, AuthorizeResult>> {
      const results = new Map<string, AuthorizeResult>();
      await boundedParallel(ids, BATCH_CONCURRENCY, async (id) => {
        const result = await checkWithCache({ subject, action, resource: { type: resourceType, id } });
        results.set(id, result);
      });
      return results;
    },

    listObjects(subject: Subject, action: Action, resourceType: ResourceType): Promise<ListObjectsResult> {
      // Registered resources have a second, authoritative availability gate.
      // The public candidate query uses fresh checks instead of graph-only lookup.
      if (isAppResource(resourceType)) return Promise.resolve({ ids: new Set(), reason: "AUTHZ_UNAVAILABLE" });
      return listObjectsWithCache(subject, action, resourceType);
    },
  };
}

// ─── Admin / PAP (writes) ─────────────────────────────────────────────────────

interface FgaTuple {
  user: string;
  relation: string;
  object: string;
}

function granteeRef(g: Grantee): string {
  switch (g.type) {
    case "user":
      return `user:${g.id}`;
    case "service_account":
      return `service_account:${g.id}`;
    case "team":
      return `team:${g.id}#member`;
    case "everyone":
      return "user:*";
  }
}

function grantTuple(intent: GrantIntent): FgaTuple {
  return {
    user: granteeRef(intent.grantee),
    relation: isAppResource(intent.resource.type) ? intent.authority === "grant" ? "grantor" : "grantee" : openFgaRelation(intent.capability),
    object: isAppResource(intent.resource.type) ? permissionObject(intent.resource.id, intent.capability) : openFgaResourceObject(intent.resource.type, intent.resource.id),
  };
}

async function fgaWrite(storeId: string, writes: FgaTuple[], deletes: FgaTuple[]): Promise<void> {
  const body = {
    ...(writes.length ? { writes: { tuple_keys: writes } } : {}),
    ...(deletes.length ? { deletes: { tuple_keys: deletes } } : {}),
  };
  const res = await requestOpenFga(`/stores/${storeId}/write`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Idempotent: writing an existing tuple / deleting an absent one is a no-op.
    if (isIdempotentWriteFailure(res.status, text, writes, deletes)) return;
    throw new Error(`OpenFGA write failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

function isIdempotentWriteFailure(status: number, text: string, writes: FgaTuple[], deletes: FgaTuple[]): boolean {
  if (status !== 400) return false;
  const writeOnly = writes.length > 0 && deletes.length === 0;
  const deleteOnly = deletes.length > 0 && writes.length === 0;
  if (writeOnly) return /already exist|duplicate/i.test(text);
  if (deleteOnly) return /does not exist|not found/i.test(text);
  return false;
}

/** Initial ownership cannot adopt an existing graph object. */
export async function assertEmptyResourceGraph(object: string): Promise<void> {
  const storeId = await getOpenFgaStoreId();
  const response = await requestOpenFga(`/stores/${storeId}/read`, { method: "POST",
    body: JSON.stringify({ tuple_key: { object }, page_size: 1, consistency: "HIGHER_CONSISTENCY" }),
    signal: AbortSignal.timeout(OPENFGA_READ_TIMEOUT_MS) });
  if (!response.ok) throw new HttpAuthzError(503, "AUTHZ_UNAVAILABLE", "Cannot verify initial resource state");
  const graph = await response.json() as { tuples?: unknown[] };
  if (!Array.isArray(graph.tuples)) throw new HttpAuthzError(503, "AUTHZ_UNAVAILABLE", "Cannot verify initial resource state");
  if (graph.tuples.length) throw new HttpAuthzError(409, "INVALID_REQUEST", "Resource already has relationships; an explicit migration is required");
}

/** The structural link is trusted registry identity, never caller-supplied authorization. */
function mapFgaCheck(resource: Resource, action: string): { object: string; relation: string; contextualTuples?: FgaTuple[] } {
  const object = openFgaResourceObject(resource.type, resource.id);
  if (!isAppResource(resource.type)) return { object, relation: openFgaCheckRelation(action) };
  if (action === "owner") return { object, relation: "owner" };
  const granting = action.startsWith("grant:");
  const permission = permissionObject(resource.id, granting ? action.slice(6) : action);
  return { object: permission, relation: granting ? "can_grant" : "can_use",
    contextualTuples: [{ user: object, relation: "resource", object: permission }] };
}
async function validateGrant(intent: GrantIntent): Promise<void> {
  if (isAppResource(intent.resource.type)) {
    if (!APP_NAME_PATTERN.test(intent.capability) || intent.capability === "owner" || intent.grantee.type === "everyone" ||
      (intent.authority !== undefined && intent.authority !== "use" && intent.authority !== "grant")) throw new HttpAuthzError(400, "INVALID_REQUEST", "Invalid app grant");
    await requireRegisteredResource(intent.resource, intent.capability);
    if (!isOpenFgaReconciliationEnabled()) throw new HttpAuthzError(503, "AUTHZ_UNAVAILABLE", "Permission updates are disabled");
  } else if (intent.authority !== undefined) throw new HttpAuthzError(400, "INVALID_REQUEST", "Core grants use capabilities");
}

export function createOpenFgaAdmin(): PolicyAdmin {
  return {
    async grant(intent: GrantIntent): Promise<void> {
      await validateGrant(intent);
      const storeId = await getOpenFgaStoreId();
      await fgaWrite(storeId, [grantTuple(intent)], []);
      invalidateDecisionCache(); // the graph changed — drop cached decisions
    },
    async revoke(intent: GrantIntent): Promise<void> {
      await validateGrant(intent);
      const storeId = await getOpenFgaStoreId();
      await fgaWrite(storeId, [], [grantTuple(intent)]);
      invalidateDecisionCache();
    },
  };
}

/**
 * Admin explanation uses the same generic action mapping as live checks.
 */
export function describeFgaCheck(req: AuthorizeRequest): {
  engine: "openfga";
  relation: string;
  user: string;
  object: string;
  store: string;
  contextual_tuples?: FgaTuple[];
} {
  return {
    engine: "openfga",
    relation: mapFgaCheck(req.resource, req.action).relation,
    user: `${req.subject.type}:${req.subject.id}`,
    object: mapFgaCheck(req.resource, req.action).object,
    contextual_tuples: mapFgaCheck(req.resource, req.action).contextualTuples,
    store: getCachedOpenFgaStoreId() || "(resolved at boot)",
  };
}
