import type { Resource, Subject } from "./contract";

export type ResourceOwner = { type: "user" | "team"; id: string };
export interface ResourceRegistration { resource: Resource; owner_team?: string }
export interface RegisteredResource {
  /** Native OpenFGA object, also Mongo's unique reservation key. */
  _id: string;
  issuer: string;
  app_id: string;
  resource: Resource;
  /** Model used at registration; current decisions use the deployment pin. */
  model_id: string;
  owner: ResourceOwner;
  creator: Subject;
  state: "pending" | "active";
  /** Set only after proving the graph contains no pre-existing relationships. */
  prepared: boolean;
  created_at: string;
}
export function resourceSnapshot(record: RegisteredResource) {
  return { resource: record.resource, app_id: record.app_id, registration_model_id: record.model_id,
    owner: record.owner, creator: record.creator, state: record.state, created_at: record.created_at };
}
