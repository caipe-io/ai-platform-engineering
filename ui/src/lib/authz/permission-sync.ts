import { randomUUID } from "node:crypto";

import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { mutationSnapshotFilter } from "@/lib/rbac/mutation-snapshot";
import {
  isOpenFgaConfigured, isOpenFgaReconciliationEnabled,
  applyOpenFgaProjection, type OpenFgaTupleKey, type TeamResourceTupleDiff,
} from "@/lib/rbac/openfga";
import { getPlatformDefaultAgentId } from "@/lib/rbac/platform-default";
import { resolveUnlinkedServiceAccountGrantState } from "@/lib/rbac/unlinked-service-account";

import { emitReconcileAudit } from "./audit";
import { invalidateDecisionCache } from "./engines/openfga";
import { type PermissionSyncStatus } from "./permission-sync-contract";
import { OpenFgaReconcileRequiredError, type TupleReconcileContext } from "./reconcile";

type ResourceCollection = "dynamic_agents" | "platform_config";
interface Projection extends PermissionSyncStatus {
  diff: TeamResourceTupleDiff;
  context: TupleReconcileContext;
  delete_resource?: boolean;
  lease?: { owner: string; until: Date };
  retry_at?: Date;
}
interface ResourceDocument extends Record<string, unknown> {
  _id: string;
  _permission_sync?: Projection;
}

export interface PermissionPersistence {
  collection: ResourceCollection;
  id: string;
  previous: object | null;
  set: object;
  unset?: Record<string, unknown>;
  deleteResource?: boolean;
}

const WRITE_OPTIONS = { writeConcern: { w: "majority" as const, wtimeoutMS: 5000 }, maxTimeMS: 5000 };
const READ_OPTIONS = { readPreference: "primary" as const, readConcern: { level: "majority" as const }, maxTimeMS: 5000 };
const LEASE_MS = 30_000;
export const PERMISSION_RETRY_MS = 15_000;

export class PermissionSaveConflictError extends Error {
  readonly statusCode = 409;
  constructor(readonly code = "ACCESS_SAVE_CONFLICT") { super("Settings changed or a permission update is still pending. Reload before making another change."); }
}

function key(tuple: OpenFgaTupleKey): string {
  return JSON.stringify([tuple.user, tuple.relation, tuple.object]);
}

/** Compose the desired state of affected keys within one pending operation. */
export function mergePermissionProjection(previous: TeamResourceTupleDiff | undefined, next: TeamResourceTupleDiff): TeamResourceTupleDiff {
  const entries = new Map<string, { tuple: OpenFgaTupleKey; present: boolean }>();
  for (const diff of [previous, next]) {
    if (!diff) continue;
    for (const tuple of diff.deletes) entries.set(key(tuple), { tuple, present: false });
    for (const tuple of diff.writes) entries.set(key(tuple), { tuple, present: true });
  }
  return {
    writes: [...entries.values()].filter(entry => entry.present).map(entry => entry.tuple),
    deletes: [...entries.values()].filter(entry => !entry.present).map(entry => entry.tuple),
  };
}

export function permissionSyncStatus(document: object | null): PermissionSyncStatus | undefined {
  const sync = (document as ResourceDocument | null)?._permission_sync;
  if (!sync) return undefined;
  return { id: sync.id, state: sync.state, requested_at: sync.requested_at, ...(sync.applied_at ? { applied_at: sync.applied_at } : {}) };
}

export function publicPermissionDocument<T extends object>(document: T): T & { permission_sync?: PermissionSyncStatus } {
  const publicDocument = { ...document } as T & { _permission_sync?: Projection };
  delete publicDocument._permission_sync;
  return { ...publicDocument, permission_sync: permissionSyncStatus(document) } as T;
}

/** Commit settings and recovery intent in ONE document write; no Mongo transaction required. */
export async function persistPermissionChange(
  persistence: PermissionPersistence,
  diff: TeamResourceTupleDiff,
  context: TupleReconcileContext,
): Promise<PermissionSyncStatus | undefined> {
  if (isOpenFgaConfigured() && !isOpenFgaReconciliationEnabled()) throw new OpenFgaReconcileRequiredError();
  const col = await getCollection<ResourceDocument>(persistence.collection);
  const previous = persistence.previous as ResourceDocument | null;
  const conflict = () => new PermissionSaveConflictError(persistence.collection === "dynamic_agents" ? "AGENT_SAVE_CONFLICT" : "PLATFORM_CONFIG_SAVE_CONFLICT");
  if (previous?._permission_sync?.state === "pending") throw conflict();
  // An applied operation no longer owns its old deletes. Replaying history could
  // remove a grant subsequently created through another administrative path.
  const combined = mergePermissionProjection(undefined, diff);
  const sync: Projection | undefined = isOpenFgaConfigured() ? {
    id: randomUUID(), state: "pending", requested_at: new Date().toISOString(),
    diff: persistence.deleteResource ? { writes: [], deletes: [...combined.writes, ...combined.deletes] } : combined, context,
    ...(persistence.deleteResource ? { delete_resource: true } : {}),
  } : undefined;
  const filter = { ...mutationSnapshotFilter(persistence.id, previous), "_permission_sync.state": { $ne: "pending" } };
  if (persistence.deleteResource && !sync) {
    if (!(await col.deleteOne(filter, WRITE_OPTIONS)).deletedCount) throw conflict();
    return;
  }
  const set = { ...persistence.set } as Record<string, unknown>;
  delete set._id;
  const fields = { ...set, authz_write_id: randomUUID(), ...(sync ? { _permission_sync: sync } : {}),
    ...(persistence.deleteResource ? { enabled: false } : {}) };
  // Keep deletion intent until grants are removed; hide it from enabled discovery.
  if (previous === null) {
    try { await col.insertOne({ _id: persistence.id, ...fields }, WRITE_OPTIONS); }
    catch (error) {
      if ((error as { code?: number }).code === 11000) throw conflict();
      throw error;
    }
  } else {
    const result = await col.updateOne(filter, {
      $set: fields,
      ...(persistence.unset && Object.keys(persistence.unset).length ? { $unset: Object.fromEntries(Object.keys(persistence.unset).map(name => [name, "" as const])) } : {}),
    }, WRITE_OPTIONS);
    if (!result.matchedCount) throw conflict();
  }
  if (!sync) return;
  const accepted = permissionSyncStatus({ _permission_sync: sync })!;
  try {
    await syncPermissionDocument(persistence.collection, persistence.id);
    const stored = await col.findOne({ _id: persistence.id }, READ_OPTIONS);
    if (stored?._permission_sync?.id === sync.id) return permissionSyncStatus(stored);
    // A newer journal can only replace an applied operation through this API.
    // Return this request's reference, never another caller's operation ID.
    if (stored?._permission_sync || (!stored && persistence.deleteResource)) return { ...accepted, state: "applied" };
  } catch (error) {
    console.error("[authz] saved permission operation awaiting confirmation", { reference: sync.id, error });
  }
  return accepted;
}

/** Public access and the unlinked account have independent, currently stored reasons. */
async function resolveProjection(diff: TeamResourceTupleDiff): Promise<TeamResourceTupleDiff> {
  const all = [...diff.writes, ...diff.deletes];
  const affectedAgentIds = [...new Set(all.filter(tuple => tuple.relation === "user" && tuple.object.startsWith("agent:")).map(tuple => tuple.object.slice(6)))];
  if (!affectedAgentIds.length) return diff;
  const agents = await getCollection<ResourceDocument>("dynamic_agents");
  const defaultId = await getPlatformDefaultAgentId();
  const unlinked = all.some(tuple => tuple.relation === "user" && tuple.user.startsWith("service_account:"))
    ? await resolveUnlinkedServiceAccountGrantState() : null;
  let resolved = diff;
  for (const id of affectedAgentIds) {
    const agent = await agents.findOne({ _id: id }, READ_OPTIONS);
    const exists = agent && !agent._permission_sync?.delete_resource;
    for (const tuple of all.filter(item => item.object === `agent:${id}` && item.relation === "user")) {
      let present: boolean | undefined;
      if (tuple.user === "user:*") present = Boolean(exists && (agent.visibility === "global" || defaultId === id));
      if (unlinked?.sub && tuple.user === `service_account:${unlinked.sub}`) present = Boolean(exists && (agent.visibility === "global" || unlinked.explicitAgentIds.has(id)));
      if (present !== undefined) resolved = mergePermissionProjection(resolved, { writes: present ? [tuple] : [], deletes: present ? [] : [tuple] });
    }
  }
  return resolved;
}

/** Any BFF replica can resume the same durable intent. Never replay a settings callback. */
export async function syncPermissionDocument(collectionName: ResourceCollection, id: string): Promise<void> {
  if (!isOpenFgaReconciliationEnabled()) return;
  const col = await getCollection<ResourceDocument>(collectionName);
  const owner = randomUUID();
  const now = new Date();
  const document = await col.findOneAndUpdate({ _id: id, "_permission_sync.state": "pending",
    $and: [
      { $or: [{ "_permission_sync.lease": { $exists: false } }, { "_permission_sync.lease.until": { $lte: now } }] },
      { $or: [{ "_permission_sync.retry_at": { $exists: false } }, { "_permission_sync.retry_at": { $lte: now } }] },
    ],
  }, { $set: { "_permission_sync.lease": { owner, until: new Date(now.getTime() + LEASE_MS) } } }, { ...WRITE_OPTIONS, returnDocument: "after" });
  const sync = document?._permission_sync;
  if (!sync) return;
  const owned = { _id: id, "_permission_sync.id": sync.id, "_permission_sync.lease.owner": owner };
  const renew = async () => {
    const result = await col.updateOne({ ...owned, "_permission_sync.lease.until": { $gt: new Date() } },
      { $set: { "_permission_sync.lease.until": new Date(Date.now() + LEASE_MS) } }, WRITE_OPTIONS);
    if (!result.matchedCount) throw new Error("Permission projection lease lost");
  };
  try {
    const diff = await resolveProjection(sync.diff);
    const result = await applyOpenFgaProjection(diff, renew);
    // Agent visibility and the platform default live in separate documents.
    // A concurrent committed change must be re-evaluated, not acknowledged
    // against the earlier cross-document read.
    if (JSON.stringify(await resolveProjection(sync.diff)) !== JSON.stringify(diff)) {
      throw new Error("Permission reasons changed during projection");
    }
    await renew();
    const acknowledged = sync.delete_resource ? (await col.deleteOne(owned, WRITE_OPTIONS)).deletedCount : (await col.updateOne(owned, {
      $set: { "_permission_sync.state": "applied", "_permission_sync.applied_at": new Date().toISOString() },
      $unset: { "_permission_sync.lease": "", "_permission_sync.retry_at": "", "_permission_sync.diff": "" },
    }, WRITE_OPTIONS)).matchedCount;
    if (!acknowledged) throw new Error("Permission completion ownership lost");
    invalidateDecisionCache();
    emitReconcileAudit(diff, result, sync.context);
  } catch (error) {
    invalidateDecisionCache();
    console.error("[authz] permission projection pending", { reference: sync.id, collection: collectionName, id, error });
    await col.updateOne(owned, { $set: { "_permission_sync.retry_at": new Date(Date.now() + PERMISSION_RETRY_MS) },
      $unset: { "_permission_sync.lease": "" } }, WRITE_OPTIONS);
  }
}

export async function retryPendingPermissions(): Promise<void> {
  if (!isMongoDBConfigured || !isOpenFgaReconciliationEnabled()) return;
  for (const name of ["dynamic_agents", "platform_config"] as const) {
    const col = await getCollection<ResourceDocument>(name);
    const now = new Date();
    const pending = await col.find({ "_permission_sync.state": "pending", $and: [
      { $or: [{ "_permission_sync.retry_at": { $exists: false } }, { "_permission_sync.retry_at": { $lte: now } }] },
      { $or: [{ "_permission_sync.lease": { $exists: false } }, { "_permission_sync.lease.until": { $lte: now } }] },
    ] }, { projection: { _id: 1 }, maxTimeMS: 5000 }).sort({ "_permission_sync.requested_at": 1 }).limit(100).toArray();
    for (const row of pending) await syncPermissionDocument(name, row._id);
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startPermissionRecovery(): void {
  if (timer || !isMongoDBConfigured) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await retryPendingPermissions(); }
    catch (error) { console.error("[authz] permission recovery unavailable", error); }
    finally { running = false; }
  };
  void tick();
  timer = setInterval(() => void tick(), PERMISSION_RETRY_MS);
  timer.unref?.();
}
