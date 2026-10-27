import type { Subject } from "./contract";

export type ResourceOwner = { type: "user" | "team"; id: string };

/** One reviewed resource kind; applications cannot register platform object types. */
export interface ResourceRegistration {
  app_id: string;
  kind: "resource";
  local_id: string;
  owner_team?: string;
}

export interface RegisteredResource {
  _id: string;
  issuer: string;
  app_id: string;
  kind: "resource";
  local_id: string;
  owner: ResourceOwner;
  creator: Subject;
  state: "pending" | "active";
  created_at: string;
}

export function resourceSnapshot(record: RegisteredResource) {
  return { resource: { type: "app_resource" as const, id: record._id }, namespace: record.app_id,
    kind: record.kind, local_id: record.local_id, owner: record.owner, creator: record.creator,
    state: record.state, created_at: record.created_at };
}
