import { loadConfiguredAgenticApps } from "@/lib/agentic-apps/config";
import { resourceApp } from "@/lib/agentic-apps/service-binding";
import { HttpAuthzError } from "./errors";
import { APP_NAME_PATTERN } from "./resource-contract";
import type { RegisteredResource } from "./resource-contract";

/** Deployment-owned declarations select names, never new OpenFGA policy. */
export function appResourceDefinition(appId: string, resourceType: string) {
  const apps = loadConfiguredAgenticApps();
  const app = resourceApp(appId, apps);
  if (!app) throw new HttpAuthzError(403, "FORBIDDEN", "Resource integration is disabled or not installed");
  const definition = app.manifest.resourceTypes?.find((item) => item.name === resourceType);
  if (!definition) throw new HttpAuthzError(400, "INVALID_REQUEST", "Resource type is not declared by this app");
  return { app, definition };
}

export function validateRegisteredAction(record: RegisteredResource, action: string): void {
  const { definition } = appResourceDefinition(record.app_id, record.resource_type);
  if (action === "owner") return;
  const name = action.startsWith("grant:") ? action.slice(6) : action;
  if (!APP_NAME_PATTERN.test(name) || !definition.actions.includes(name)) {
    throw new HttpAuthzError(400, "INVALID_REQUEST", "Action is not declared for this resource type");
  }
}

export function declaredResourceActions(record: RegisteredResource): string[] {
  const { definition } = appResourceDefinition(record.app_id, record.resource_type);
  return ["owner", ...definition.actions, ...definition.actions.map((action) => `grant:${action}`)];
}

export function listAppResourceTypeDefinition() {
  let actions: string[] = [];
  try { actions = loadConfiguredAgenticApps().flatMap(({ manifest }) => manifest.resourceTypes?.flatMap((item) => item.actions) ?? []); }
  catch (error) {
    console.warn("[cas/resources] App declarations unavailable for admin inventory", { name: error instanceof Error ? error.name : "UnknownError" });
    return { type: "app_resource", actions: ["owner"], description: "App declarations unavailable; check installation configuration" };
  }
  return { type: "app_resource", actions: [...new Set(["owner", ...actions, ...actions.map((action) => `grant:${action}`)])],
    description: "App resources registered in CAS; permissions are defined per app resource type" };
}
