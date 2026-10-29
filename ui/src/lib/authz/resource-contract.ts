import type { Resource, Subject } from "./contract";

export const APP_RESOURCE_TYPE = "app_resource";
export const APP_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,49}$/;
export const RESOURCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isAppResource(type: string): type is "app_resource" { return type === APP_RESOURCE_TYPE; }
export type ResourceOwner = { type: "user" | "team"; id: string };
export interface ResourceRegistration { app_id: string; resource_type: string; local_id: string; owner_team?: string }
export interface RegisteredResource {
  _id: string;
  issuer: string;
  app_id: string;
  resource_type: string;
  local_id: string;
  owner: ResourceOwner;
  creator: Subject;
  state: "pending" | "active";
  prepared: boolean;
  created_at: string;
}
export function registeredResource(record: Pick<RegisteredResource, "_id">): Resource {
  return { type: APP_RESOURCE_TYPE, id: record._id };
}
export function resourceSnapshot(record: RegisteredResource) {
  return { resource: registeredResource(record), app_id: record.app_id, resource_type: record.resource_type,
    local_id: record.local_id, owner: record.owner, creator: record.creator, state: record.state, created_at: record.created_at };
}
/** Only CAS constructs this identity; caller IDs are never OpenFGA type/relation syntax. */
export function permissionObject(id: string, action: string): string { return `app_permission:${id}/${action}`; }
