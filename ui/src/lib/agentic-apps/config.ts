import fs from "node:fs";
import yaml from "js-yaml";

import type {
  AgenticAppInstallation,
  AgenticAppManifest,
  AgenticAppPolicyAction,
  ConfiguredAgenticApp,
} from "@/types/agentic-app";

const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

type RawPackage = {
  package_id?: unknown;
  manifest?: unknown;
};

type RawInstallation = {
  app_id?: unknown;
  package_id?: unknown;
  installed?: unknown;
  enabled?: unknown;
  visible?: unknown;
  runtime_mount_path?: unknown;
  runtime_origin_override?: unknown;
  access_overrides?: unknown;
};

export function isAgenticAppsEnabled(): boolean {
  return process.env.AGENTIC_APPS_INSTALL_ENABLED === "true";
}

/**
 * Load the deployment-owned External Apps catalog.
 *
 * The file is intentionally read on demand. Kubernetes updates ConfigMap
 * mounts atomically, so a corrected catalog becomes visible without writing
 * deployment data into MongoDB or restarting every UI replica.
 */
export function loadConfiguredAgenticApps(
  configPath = process.env.AGENTIC_APPS_CONFIG_PATH?.trim(),
): ConfiguredAgenticApp[] {
  if (!isAgenticAppsEnabled()) return [];
  if (!configPath) {
    throw new Error(
      "AGENTIC_APPS_CONFIG_PATH is required when AGENTIC_APPS_INSTALL_ENABLED=true",
    );
  }
  if (!fs.existsSync(configPath)) {
    throw new Error(`External Apps config does not exist: ${configPath}`);
  }

  const root = asRecord(yaml.load(fs.readFileSync(configPath, "utf8")), "config");
  const section = asRecord(root.agentic_apps, "agentic_apps");
  const rawPackages = asArray(section.packages, "agentic_apps.packages");
  const rawInstallations = asArray(
    section.installations,
    "agentic_apps.installations",
  );

  const packages = new Map<string, AgenticAppManifest>();
  rawPackages.forEach((entry, index) => {
    const raw = asRecord(entry, `agentic_apps.packages[${index}]`) as RawPackage;
    const packageId = requiredString(
      raw.package_id,
      `agentic_apps.packages[${index}].package_id`,
    );
    if (packages.has(packageId)) {
      throw new Error(`Duplicate External App package_id: ${packageId}`);
    }
    const manifest = parseManifest(
      raw.manifest,
      `agentic_apps.packages[${index}].manifest`,
    );
    if (manifest.id !== packageId) {
      throw new Error(
        `External App package "${packageId}" must use the same manifest id`,
      );
    }
    packages.set(packageId, manifest);
  });

  const apps: ConfiguredAgenticApp[] = rawInstallations.map((entry, index) => {
    const path = `agentic_apps.installations[${index}]`;
    const raw = asRecord(entry, path) as RawInstallation;
    const appId = requiredAppId(raw.app_id, `${path}.app_id`);
    const packageId = requiredString(raw.package_id, `${path}.package_id`);
    const manifest = packages.get(packageId);
    if (!manifest) {
      throw new Error(
        `${path} references package "${packageId}" that is not configured`,
      );
    }
    if (appId !== manifest.id) {
      throw new Error(`${path}.app_id must match manifest id "${manifest.id}"`);
    }

    const installation: AgenticAppInstallation = {
      appId,
      packageId,
      installed: optionalBoolean(raw.installed, true, `${path}.installed`),
      enabled: optionalBoolean(raw.enabled, true, `${path}.enabled`),
      visible: optionalBoolean(raw.visible, true, `${path}.visible`),
      ...(raw.runtime_mount_path !== undefined
        ? {
            runtimeMountPath: requiredMountPath(
              raw.runtime_mount_path,
              `${path}.runtime_mount_path`,
            ),
          }
        : {}),
      ...(raw.runtime_origin_override !== undefined
        ? {
            runtimeOriginOverride: requiredHttpOrigin(
              raw.runtime_origin_override,
              `${path}.runtime_origin_override`,
            ),
          }
        : {}),
      ...(raw.access_overrides !== undefined
        ? {
            accessOverrides: parseAccessOverrides(
              raw.access_overrides,
              `${path}.access_overrides`,
            ),
          }
        : {}),
    };
    return { manifest, installation };
  });

  const appIds = new Set<string>();
  const mountPaths = new Map<string, string>();
  for (const app of apps) {
    if (appIds.has(app.installation.appId)) {
      throw new Error(`Duplicate External App installation: ${app.installation.appId}`);
    }
    appIds.add(app.installation.appId);
    const mountPath = app.installation.runtimeMountPath ?? app.manifest.runtime.mountPath;
    const expectedMountPath = `/apps/${app.installation.appId}`;
    if (mountPath !== expectedMountPath) {
      throw new Error(
        `External App "${app.installation.appId}" must use mount path "${expectedMountPath}"`,
      );
    }
    const owner = mountPaths.get(mountPath);
    if (owner) {
      throw new Error(
        `External App mount path "${mountPath}" is used by both "${owner}" and "${app.installation.appId}"`,
      );
    }
    mountPaths.set(mountPath, app.installation.appId);
    const origin = app.installation.runtimeOriginOverride ?? app.manifest.runtime.origin;
    if (app.installation.installed && app.installation.enabled && !origin) {
      throw new Error(
        `External App "${app.installation.appId}" requires a runtime origin when enabled`,
      );
    }
  }

  return apps.sort((left, right) => {
    const leftOrder = left.manifest.surfaces.navOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.manifest.surfaces.navOrder ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.manifest.displayName.localeCompare(right.manifest.displayName);
  });
}

export function getConfiguredAgenticApp(appId: string): ConfiguredAgenticApp | null {
  return loadConfiguredAgenticApps().find((app) => app.installation.appId === appId) ?? null;
}

function parseManifest(value: unknown, path: string): AgenticAppManifest {
  const raw = asRecord(value, path);
  const id = requiredAppId(raw.id, `${path}.id`);
  if (raw.apiVersion !== "1.0") {
    throw new Error(`${path}.apiVersion must be "1.0"`);
  }

  const runtimeRaw = asRecord(raw.runtime, `${path}.runtime`);
  if (runtimeRaw.kind !== "proxied-next-zone") {
    throw new Error(`${path}.runtime.kind must be "proxied-next-zone"`);
  }
  if (runtimeRaw.chrome !== undefined && runtimeRaw.chrome !== "iframe") {
    throw new Error(`${path}.runtime.chrome must be "iframe" when set`);
  }

  const surfacesRaw = asRecord(raw.surfaces, `${path}.surfaces`);
  const accessRaw = asRecord(raw.access, `${path}.access`);
  assertKnownKeys(
    accessRaw,
    [
      "requiredRoles",
      "tokenScopes",
      "policyActions",
      // Accepted catalog metadata from the existing manifest contract. This
      // config-only runtime does not otherwise consume it.
      "canUseCustomAgents",
    ],
    `${path}.access`,
  );
  const tokenScopes = requiredStringArray(
    accessRaw.tokenScopes,
    `${path}.access.tokenScopes`,
  );
  const policyActions = asArray(
    accessRaw.policyActions,
    `${path}.access.policyActions`,
  ).map((entry, index) =>
    parsePolicyAction(entry, `${path}.access.policyActions[${index}]`),
  );
  if (policyActions.length === 0) {
    throw new Error(`${path}.access.policyActions must declare at least one action`);
  }
  const declaredScopes = new Set(tokenScopes);
  for (const policy of policyActions) {
    const undeclaredScope = policy.requiredScopes?.find(
      (scope) => !declaredScopes.has(scope),
    );
    if (undeclaredScope) {
      throw new Error(
        `${path}.access policy "${policy.action}" requires undeclared scope "${undeclaredScope}"`,
      );
    }
  }

  const catalogRaw = raw.catalog === undefined
    ? undefined
    : asRecord(raw.catalog, `${path}.catalog`);
  const healthRaw = raw.health === undefined
    ? undefined
    : asRecord(raw.health, `${path}.health`);

  return {
    id,
    displayName: requiredString(raw.displayName, `${path}.displayName`),
    description: requiredString(raw.description, `${path}.description`),
    apiVersion: "1.0",
    runtime: {
      kind: "proxied-next-zone",
      mountPath: requiredMountPath(runtimeRaw.mountPath, `${path}.runtime.mountPath`),
      ...(runtimeRaw.origin !== undefined
        ? { origin: requiredHttpOrigin(runtimeRaw.origin, `${path}.runtime.origin`) }
        : {}),
      ...(runtimeRaw.preserveMountPath !== undefined
        ? {
            preserveMountPath: optionalBoolean(
              runtimeRaw.preserveMountPath,
              false,
              `${path}.runtime.preserveMountPath`,
            ),
          }
        : {}),
      ...(runtimeRaw.chrome === "iframe" ? { chrome: "iframe" as const } : {}),
    },
    surfaces: {
      showInHub: optionalBoolean(
        surfacesRaw.showInHub,
        true,
        `${path}.surfaces.showInHub`,
      ),
      ...(surfacesRaw.navOrder !== undefined
        ? { navOrder: requiredNumber(surfacesRaw.navOrder, `${path}.surfaces.navOrder`) }
        : {}),
      ...(surfacesRaw.homeEligible !== undefined
        ? {
            homeEligible: optionalBoolean(
              surfacesRaw.homeEligible,
              false,
              `${path}.surfaces.homeEligible`,
            ),
          }
        : {}),
    },
    access: {
      tokenScopes,
      policyActions,
      ...(accessRaw.requiredRoles !== undefined
        ? {
            requiredRoles: requiredStringArray(
              accessRaw.requiredRoles,
              `${path}.access.requiredRoles`,
              true,
            ),
          }
        : {}),
    },
    ...(healthRaw
      ? {
          health: {
            endpoint: requiredAbsolutePath(healthRaw.endpoint, `${path}.health.endpoint`),
            ...(healthRaw.timeoutMs !== undefined
              ? { timeoutMs: requiredNumber(healthRaw.timeoutMs, `${path}.health.timeoutMs`) }
              : {}),
          },
        }
      : {}),
    ...(catalogRaw
      ? {
          catalog: {
            ...(catalogRaw.categories !== undefined
              ? {
                  categories: requiredStringArray(
                    catalogRaw.categories,
                    `${path}.catalog.categories`,
                    true,
                  ),
                }
              : {}),
            ...(catalogRaw.capabilities !== undefined
              ? {
                  capabilities: requiredStringArray(
                    catalogRaw.capabilities,
                    `${path}.catalog.capabilities`,
                    true,
                  ),
                }
              : {}),
            ...(catalogRaw.icon !== undefined
              ? { icon: requiredString(catalogRaw.icon, `${path}.catalog.icon`) }
              : {}),
            ...(catalogRaw.supportUrl !== undefined
              ? {
                  supportUrl: requiredHttpOrigin(
                    catalogRaw.supportUrl,
                    `${path}.catalog.supportUrl`,
                    true,
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
}

function parsePolicyAction(value: unknown, path: string): AgenticAppPolicyAction {
  const raw = asRecord(value, path);
  assertKnownKeys(
    raw,
    [
      "action",
      "description",
      "defaultEffect",
      "reasonCode",
      "requiredScopes",
      "method",
      "path",
    ],
    path,
  );
  const method = raw.method === undefined
    ? undefined
    : requiredString(raw.method, `${path}.method`).toUpperCase();
  if (method && !HTTP_METHODS.has(method)) {
    throw new Error(`${path}.method is not supported`);
  }
  if ((raw.method === undefined) !== (raw.path === undefined)) {
    throw new Error(`${path}.method and ${path}.path must be declared together`);
  }
  const defaultEffect = raw.defaultEffect ?? "deny";
  if (defaultEffect !== "allow" && defaultEffect !== "deny") {
    throw new Error(`${path}.defaultEffect must be "allow" or "deny"`);
  }
  return {
    action: requiredString(raw.action, `${path}.action`),
    defaultEffect,
    ...(raw.description !== undefined
      ? { description: requiredString(raw.description, `${path}.description`) }
      : {}),
    ...(raw.reasonCode !== undefined
      ? { reasonCode: requiredString(raw.reasonCode, `${path}.reasonCode`) }
      : {}),
    ...(raw.requiredScopes !== undefined
      ? {
          requiredScopes: requiredStringArray(
            raw.requiredScopes,
            `${path}.requiredScopes`,
          ),
        }
      : {}),
    ...(method ? { method: method as AgenticAppPolicyAction["method"] } : {}),
    ...(raw.path !== undefined
      ? { path: requiredAbsolutePath(raw.path, `${path}.path`) }
      : {}),
  };
}

function parseAccessOverrides(
  value: unknown,
  path: string,
): AgenticAppInstallation["accessOverrides"] {
  const raw = asRecord(value, path);
  const unknown = Object.keys(raw).find(
    (key) => key !== "requiredRoles" && key !== "required_roles",
  );
  if (unknown) throw new Error(`${path} has unknown key "${unknown}"`);
  const roles = raw.requiredRoles ?? raw.required_roles;
  return {
    ...(roles !== undefined
      ? { requiredRoles: requiredStringArray(roles, `${path}.requiredRoles`, true) }
      : {}),
  };
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${path} has unknown key "${unknown}"`);
}

function requiredString(value: unknown, path: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new Error(`${path} must be a non-empty string`);
  return result;
}

function requiredAppId(value: unknown, path: string): string {
  const result = requiredString(value, path);
  if (!APP_ID_PATTERN.test(result)) {
    throw new Error(`${path} must be a lowercase DNS-style identifier`);
  }
  return result;
}

function optionalBoolean(
  value: unknown,
  fallback: boolean,
  path: string,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function requiredNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function requiredStringArray(
  value: unknown,
  path: string,
  allowEmpty = false,
): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${path} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  return value.map((entry, index) => requiredString(entry, `${path}[${index}]`));
}

function requiredAbsolutePath(value: unknown, path: string): string {
  const result = requiredString(value, path);
  if (!result.startsWith("/") || result.startsWith("//")) {
    throw new Error(`${path} must be an absolute path`);
  }
  return result;
}

function requiredMountPath(value: unknown, path: string): string {
  const result = requiredAbsolutePath(value, path).replace(/\/+$/, "");
  if (!result.startsWith("/apps/")) {
    throw new Error(`${path} must be below /apps/`);
  }
  return result;
}

function requiredHttpOrigin(
  value: unknown,
  path: string,
  allowPath = false,
): string {
  const raw = requiredString(value, path);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${path} must be an absolute HTTP(S) URL`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || (!allowPath && parsed.pathname !== "/")
    || (!allowPath && (parsed.search || parsed.hash))
  ) {
    throw new Error(`${path} must be an HTTP(S) origin without credentials`);
  }
  return allowPath ? parsed.toString() : parsed.origin;
}
