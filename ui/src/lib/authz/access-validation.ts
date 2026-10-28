import { isSupportedResourceAction } from "@/lib/rbac/resource-model";
import type { Action, GrantIntent, Resource } from "./contract";
import { HttpAuthzError } from "./errors";
import { isValidResourceId, parseAction, parseGrantee, parseGrantIntent, parseResource } from "./http";
import { isNativeResourceType, MODEL_NAME_PATTERN, nativeGrantRelation, requireNativePermission } from "./model";

export async function parseAccessResource(raw: unknown): Promise<Resource> {
  const item = raw as Partial<Resource> | null;
  if (!item || Object.keys(item).some((key) => !["type", "id"].includes(key)) || typeof item.type !== "string" || !MODEL_NAME_PATTERN.test(item.type) || !isValidResourceId(item.type, item.id)) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "A valid resource type and ID are required");
  }
  if (!isNativeResourceType(item.type)) return parseResource(raw);
  return { type: item.type, id: item.id };
}

export async function parseAccessAction(type: string, raw: unknown): Promise<Action> {
  if (!isNativeResourceType(type)) {
    const action = parseAction(raw);
    if (!isSupportedResourceAction(type, action)) throw new HttpAuthzError(400, "INVALID_REQUEST", "Action is not supported on this resource type");
    return action;
  }
  if (typeof raw !== "string" || !MODEL_NAME_PATTERN.test(raw)) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "A native model permission is required");
  }
  await requireNativePermission(type, raw);
  return raw;
}

export async function parseAccessGrant(body: Record<string, unknown>): Promise<GrantIntent> {
  const resource = await parseAccessResource(body.resource);
  if (!isNativeResourceType(resource.type)) {
    if (body.relationship !== undefined) throw new HttpAuthzError(400, "INVALID_REQUEST", "Core grants use capabilities");
    return parseGrantIntent(body);
  }
  if (body.capability !== undefined || typeof body.relationship !== "string" || !MODEL_NAME_PATTERN.test(body.relationship)) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "Use a native model relationship for application grants");
  }
  const grantee = parseGrantee(body.grantee);
  await nativeGrantRelation(resource.type, body.relationship, grantee.type);
  return { resource, grantee, relationship: body.relationship };
}
