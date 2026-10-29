import { isSupportedResourceAction } from "@/lib/rbac/resource-model";
import type { Action, GrantIntent, Resource } from "./contract";
import { HttpAuthzError } from "./errors";
import { isValidResourceId, parseAction, parseGrantee, parseGrantIntent, parseResource } from "./http";
import { APP_NAME_PATTERN, isAppResource, RESOURCE_ID_PATTERN } from "./resource-contract";

export async function parseAccessResource(raw: unknown): Promise<Resource> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpAuthzError(400, "INVALID_REQUEST", "A resource is required");
  const item = raw as Partial<Resource>;
  if (Object.keys(item).some((key) => !["type", "id"].includes(key)) || typeof item.type !== "string" || !isValidResourceId(item.type, item.id)) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "A valid resource type and ID are required");
  }
  if (!isAppResource(item.type)) return parseResource(raw);
  if (!RESOURCE_ID_PATTERN.test(item.id)) throw new HttpAuthzError(400, "INVALID_REQUEST", "A registered resource handle is required");
  return { type: "app_resource", id: item.id };
}
export async function parseAccessAction(resource: Resource, raw: unknown): Promise<Action> {
  if (!isAppResource(resource.type)) {
    const action = parseAction(raw);
    if (!isSupportedResourceAction(resource.type, action)) throw new HttpAuthzError(400, "INVALID_REQUEST", "Action is not supported on this resource type");
    return action;
  }
  if (typeof raw !== "string" || (raw !== "owner" && !APP_NAME_PATTERN.test(raw.startsWith("grant:") ? raw.slice(6) : raw))) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "A declared app action is required");
  }
  return raw;
}
export async function parseAccessGrant(body: Record<string, unknown>): Promise<GrantIntent> {
  const resource = await parseAccessResource(body.resource);
  if (!isAppResource(resource.type)) {
    if (body.authority !== undefined) throw new HttpAuthzError(400, "INVALID_REQUEST", "authority is only supported for app resources");
    return parseGrantIntent(body);
  }
  if (typeof body.capability !== "string" || !APP_NAME_PATTERN.test(body.capability) || body.capability === "owner" ||
    (body.authority !== undefined && body.authority !== "use" && body.authority !== "grant")) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "A declared action and use/grant authority are required");
  }
  const grantee = parseGrantee(body.grantee);
  if (grantee.type === "everyone") throw new HttpAuthzError(400, "INVALID_REQUEST", "App grants require a user, team or service account");
  await parseAccessAction(resource, body.capability);
  return { resource, grantee, capability: body.capability, authority: body.authority === "grant" ? "grant" : "use" };
}
