import type { Resource, Subject } from "./contract";

export const APP_RESOURCE_TYPE = "app_resource";
export const APP_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,49}$/;
export const RESOURCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isAppResource(type: string): type is "app_resource" { return type === APP_RESOURCE_TYPE; }
export type ResourceOwner = { type: "user" | "team"; id: string };
export interface ResourceLifecycleAudit {
  operation: "transfer" | "retire";
  previous_owner: ResourceOwner;
  owner: ResourceOwner;
  previous_owner_version: string;
  owner_version: string;
}
/** Return only the published audit fields, never arbitrary producer metadata. */
export function safeResourceLifecycle(value: unknown): ResourceLifecycleAudit | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as Partial<ResourceLifecycleAudit>;
  const owner = (input: unknown): ResourceOwner | undefined => {
    if (!input || typeof input !== "object") return;
    const candidate = input as Partial<ResourceOwner>;
    return (candidate.type === "user" || candidate.type === "team") && typeof candidate.id === "string" && candidate.id.length > 0 && candidate.id.length <= 256
      ? { type: candidate.type, id: candidate.id } : undefined;
  };
  const previous = owner(item.previous_owner); const next = owner(item.owner);
  if (!["transfer", "retire"].includes(item.operation ?? "") || !previous || !next ||
    typeof item.previous_owner_version !== "string" || !RESOURCE_ID_PATTERN.test(item.previous_owner_version) ||
    typeof item.owner_version !== "string" || !RESOURCE_ID_PATTERN.test(item.owner_version)) return;
  return { operation: item.operation as "transfer" | "retire", previous_owner: previous, owner: next,
    previous_owner_version: item.previous_owner_version, owner_version: item.owner_version };
}
export interface ResourceRegistration { app_id: string; resource_type: string; local_id: string; owner_team?: string }
export interface RegisteredResource {
  _id: string;
  issuer: string;
  app_id: string;
  resource_type: string;
  local_id: string;
  owner: ResourceOwner;
  creator: Subject;
  state: "pending" | "active" | "retired";
  /** Absent on initial ownership; a transfer selects a new immutable graph node. */
  owner_version?: string;
  retired_at?: string;
  retired_by?: Subject;
  prepared: boolean;
  created_at: string;
}
export function registeredResource(record: Pick<RegisteredResource, "_id">): Resource {
  return { type: APP_RESOURCE_TYPE, id: record._id };
}
export function resourceSnapshot(record: RegisteredResource) {
  return { resource: registeredResource(record), app_id: record.app_id, resource_type: record.resource_type,
    local_id: record.local_id, owner: record.owner, owner_version: resourceOwnerVersion(record), creator: record.creator,
    state: record.state, created_at: record.created_at, ...(record.retired_at ? { retired_at: record.retired_at, retired_by: record.retired_by } : {}) };
}
export function resourceOwnerVersion(record: Pick<RegisteredResource, "_id" | "owner_version">): string {
  return record.owner_version ?? record._id;
}
/** Stable action objects keep their grants; only their trusted ownership link changes. */
export function resourceOwnerObject(record: Pick<RegisteredResource, "_id" | "owner_version">): string {
  return `app_resource:${record._id}${record.owner_version ? `/owners/${record.owner_version}` : ""}`;
}
/** Only CAS constructs this identity; caller IDs are never OpenFGA type/relation syntax. */
export function permissionObject(id: string, action: string): string { return `app_permission:${id}/${action}`; }
