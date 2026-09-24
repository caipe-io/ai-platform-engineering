import type { Action, AuthorizeResult, GrantIntent, Resource, ResourceType } from "./contract";

/** The authenticated caller is the subject; clients cannot supply one. */
export interface AccessCheckRequest {
  resource: Resource;
  action: Action;
}

export type AccessCheckResponse = AuthorizeResult;

/** Filter a bounded candidate page, not an unbounded resource catalog. */
export interface AccessQueryRequest {
  resource_type: ResourceType;
  action: Action;
  ids: string[];
}

export interface AccessQueryResponse {
  ids: string[];
}

export type AccessGrantRequest = GrantIntent;
export type AccessGrantResponse = { granted: true } | { revoked: true };
export const ACCESS_QUERY_MAX_IDS = 200;
