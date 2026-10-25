import {
  RESERVED_HOST_PATHS,
  RESERVED_API_PATHS,
  pathsOverlap,
} from "./reserved-paths.mjs";
import {
  CONTRACT_VERSION,
  LEGACY_NATIVE_CONTRACT_VERSION,
  isSupportedNativeContractVersion,
} from "./contract-version.mjs";

const ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PACKAGE = /^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const HOST_APIS = new Set([
  "host.navigation",
  "host.breadcrumbs",
  "host.theme",
  "host.session",
  "host.chat",
  "host.notifications",
  "app.gateway",
]);

function record(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be an object`);
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(`${path} has an unknown field`);
  return value;
}
function string(value, path) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${path} must be a non-empty string`);
  return value;
}
function list(value, path) {
  if (!Array.isArray(value) || value.length > 200)
    throw new Error(`${path} must be an array of at most 200 items`);
  return value;
}
function strings(value, path) {
  const values = list(value, path).map((item) => string(item, path));
  if (new Set(values).size !== values.length)
    throw new Error(`${path} has duplicate values`);
  return values;
}
function identifier(value, path) {
  if (!ID.test(string(value, path)))
    throw new Error(`${path} must be a lowercase DNS-style identifier`);
  return value;
}
function pathValue(value, path) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    (value.length > 1 && value.endsWith("/")) ||
    /\.\.|[?#\\\u0000-\u001f\u007f]|\/\/|%2f|%5c|%2e/i.test(value)
  )
    throw new Error(`${path} must be a safe absolute path`);
  return value;
}
function boolean(value, path) {
  if (typeof value !== "boolean") throw new Error(`${path} must be boolean`);
  return value;
}
function emptyCapabilities() {
  return {
    provides: { mcp: [], agents: [], workflows: [] },
    consumes: { platformApis: [] },
    requestedPermissions: [],
  };
}

/** Only reviewed, same-origin assets in the owning app's namespace are rendered. */
export function resolveAgenticAppIcon(appId, icon) {
  if (typeof appId !== "string" || !ID.test(appId) || typeof icon !== "string" || icon.length > 200) return undefined;
  const prefix = `/app-icons/${appId}/`;
  if (!icon.startsWith(prefix)) return undefined;
  const filename = icon.slice(prefix.length);
  return /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.(?:svg|png|webp|jpe?g)$/.test(filename) && !filename.includes("..")
    ? icon : undefined;
}

/** Validate publisher declarations. Permission requests never become grants here. */
export function validateAgenticAppManifest(value) {
  const app = record(
    value,
    [
      "id",
      "displayName",
      "description",
      "apiVersion",
      "version",
      "ui",
      "api",
      "auth",
      "runtime",
      "surfaces",
      "access",
      "provides",
      "consumes",
      "requestedPermissions",
      "health",
      "catalog",
    ],
    "manifest",
  );
  if (app.apiVersion !== "2.0")
    throw new Error("manifest.apiVersion must be 2.0");
  identifier(app.id, "manifest.id");
  const version =
    typeof app.version === "string" ? app.version.match(VERSION) : null;
  if (
    !version ||
    version[4]
      ?.split(".")
      .some(
        (part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"),
      )
  )
    throw new Error("manifest.version must be an exact semantic version");
  string(app.displayName, "displayName");
  if (typeof app.description !== "string")
    throw new Error("description must be a string");
  const ui = record(
    app.ui,
    ["profiles", "routes", "slots", "navigation", "assistant"],
    "ui",
  );
  const profiles = list(ui.profiles, "ui.profiles");
  const profileIds = new Set();
  const modes = new Set();
  for (const profile of profiles) {
    record(profile, ["id", "mode", "package", "contractVersion"], "ui.profile");
    identifier(profile.id, "ui.profile.id");
    if (profileIds.has(profile.id) || modes.has(profile.mode))
      throw new Error("duplicate UI profile id or mode");
    profileIds.add(profile.id);
    modes.add(profile.mode);
    if (profile.mode === "native-package") {
      if (
        !PACKAGE.test(profile.package ?? "") ||
        !isSupportedNativeContractVersion(profile.contractVersion)
      )
        throw new Error(
          `native profile requires a package and contractVersion ${CONTRACT_VERSION} (legacy ${LEGACY_NATIVE_CONTRACT_VERSION} is also supported)`,
        );
    } else if (
      profile.mode !== "iframe" ||
      profile.package !== undefined ||
      profile.contractVersion !== undefined
    ) {
      throw new Error("invalid iframe profile");
    }
  }
  const routes = list(ui.routes, "ui.routes");
  const routeIds = new Set();
  const routePaths = new Set();
  for (const route of routes) {
    record(route, ["id", "path"], "ui.route");
    identifier(route.id, "ui.route.id");
    pathValue(route.path, "ui.route.path");
    if (routeIds.has(route.id) || routePaths.has(route.path))
      throw new Error("duplicate route id or path");
    routeIds.add(route.id);
    routePaths.add(route.path);
  }
  const slots = strings(ui.slots === undefined ? [] : ui.slots, "ui.slots");
  if (
    modes.has("native-package") &&
    routes.some((route) =>
      RESERVED_HOST_PATHS.some(
        (reserved) =>
          route.path === reserved || route.path.startsWith(`${reserved}/`),
      ),
    )
  )
    throw new Error("invalid or reserved host path");
  if (slots.some((slot) => slot !== "home"))
    throw new Error("unsupported slot");
  if (
    !profiles.length &&
    (routes.length || slots.length || ui.navigation || ui.assistant)
  )
    throw new Error("service-only apps cannot claim UI surfaces");
  if (modes.has("native-package") && !routes.length && !slots.length)
    throw new Error("native profile requires a route or slot");
  if (ui.navigation !== undefined) {
    const nav = record(
      ui.navigation,
      ["label", "routeRef", "href", "placement", "icon"],
      "ui.navigation",
    );
    string(nav.label, "ui.navigation.label");
    if (
      !routeIds.has(nav.routeRef) ||
      nav.placement !== "after-chat" ||
      (nav.icon !== undefined &&
        !["book-open", "layout-grid"].includes(nav.icon))
    )
      throw new Error(
        "navigation must reference an owned route and supported placement/icon",
      );
    const owned = routes.find((route) => route.id === nav.routeRef).path;
    if (
      nav.href !== undefined &&
      pathValue(nav.href, "ui.navigation.href") !== owned &&
      !nav.href.startsWith(`${owned}/`)
    )
      throw new Error("navigation href must remain inside its route");
  }
  if (ui.assistant !== undefined) {
    const assistant = record(
      ui.assistant,
      ["agentId", "label", "name", "streamPath", "resumePath", "cancelPath", "statusPath", "overlay"],
      "ui.assistant",
    );
    identifier(assistant.agentId, "ui.assistant.agentId");
    if (assistant.overlay !== undefined && !["host", "app"].includes(assistant.overlay))
      throw new Error("assistant overlay must be host or app");
    if (
      string(assistant.label, "ui.assistant.label").length > 48 ||
      string(assistant.name, "ui.assistant.name").length > 80
    )
      throw new Error("assistant label/name is too long");
    for (const field of ["streamPath", "resumePath", "cancelPath", "statusPath"]) {
      if (assistant[field] === undefined) continue;
      pathValue(assistant[field], `ui.assistant.${field}`);
      if (!assistant[field].startsWith("/api/") || !app.runtime)
        throw new Error(`assistant ${field} requires an app runtime API path`);
      if (field !== "streamPath" && !assistant.streamPath)
        throw new Error(`assistant ${field} requires streamPath`);
    }
  }
  record(app.auth, ["mode"], "auth");
  if (
    !["app-scoped-token", "forward-user-access-token"].includes(app.auth.mode)
  )
    throw new Error(
      "auth.mode must be app-scoped-token or forward-user-access-token",
    );
  record(app.api, ["mounts"], "api");
  strings(app.api.mounts, "api.mounts").forEach((mount) => {
    if (!pathValue(mount, "api.mount").startsWith("/api/"))
      throw new Error("invalid API mount");
    if (RESERVED_API_PATHS.some((reserved) => pathsOverlap(reserved, mount)))
      throw new Error("reserved API mount");
  });
  if (app.api.mounts.length && !modes.has("native-package"))
    throw new Error("custom API mounts require a compiled native profile");
  if (app.runtime !== undefined) {
    record(
      app.runtime,
      ["kind", "mountPath", "preserveMountPath", "maxRequestBodyBytes"],
      "runtime",
    );
    if (
      app.runtime.kind !== "proxied-next-zone" ||
      app.runtime.mountPath !== `/apps/${app.id}`
    )
      throw new Error("runtime must use the app's canonical /apps mount");
    if (app.runtime.preserveMountPath !== undefined)
      boolean(app.runtime.preserveMountPath, "runtime.preserveMountPath");
    const limit = app.runtime.maxRequestBodyBytes;
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 * 1024 * 1024)
    )
      throw new Error("invalid maxRequestBodyBytes");
  }
  if (modes.has("iframe") && !app.runtime)
    throw new Error("iframe profile requires a runtime binding");
  if (
    modes.has("iframe") &&
    !modes.has("native-package") &&
    routes.some((route) => route.path !== `/apps/${app.id}`)
  )
    throw new Error("iframe-only routes must use the canonical /apps mount");
  record(app.surfaces, ["showInHub", "navOrder", "homeEligible"], "surfaces");
  boolean(app.surfaces.showInHub, "surfaces.showInHub");
  if (
    app.surfaces.navOrder !== undefined &&
    !Number.isFinite(app.surfaces.navOrder)
  )
    throw new Error("invalid navOrder");
  if (app.surfaces.homeEligible !== undefined)
    boolean(app.surfaces.homeEligible, "surfaces.homeEligible");
  if (!profiles.length && app.surfaces.showInHub)
    throw new Error("service-only apps cannot be shown in the hub");
  record(
    app.access,
    ["requiredRoles", "tokenScopes", "policyActions"],
    "access",
  );
  strings(
    app.access.requiredRoles === undefined ? [] : app.access.requiredRoles,
    "access.requiredRoles",
  );
  const scopes = new Set(strings(app.access.tokenScopes, "access.tokenScopes"));
  const policies = list(app.access.policyActions, "access.policyActions");
  const policyIds = new Set();
  for (const policy of policies) {
    record(
      policy,
      [
        "action",
        "description",
        "defaultEffect",
        "reasonCode",
        "requiredScopes",
        "method",
        "path",
      ],
      "policy",
    );
    string(policy.action, "policy.action");
    const key = policy.method
      ? `${policy.method}:${policy.path}`
      : policy.action;
    if (policyIds.has(key)) throw new Error("duplicate policy action or route");
    policyIds.add(key);
    if (policy.description !== undefined)
      string(policy.description, "policy.description");
    if (policy.reasonCode !== undefined)
      string(policy.reasonCode, "policy.reasonCode");
    if (!["allow", "deny"].includes(policy.defaultEffect))
      throw new Error("policy requires an explicit defaultEffect");
    if ((policy.method === undefined) !== (policy.path === undefined))
      throw new Error("policy method and path must be declared together");
    if (
      policy.method !== undefined &&
      (!METHODS.has(policy.method) || !pathValue(policy.path, "policy.path"))
    )
      throw new Error("invalid policy method/path");
    if (
      strings(
        policy.requiredScopes === undefined ? [] : policy.requiredScopes,
        "policy.requiredScopes",
      ).some((scope) => !scopes.has(scope))
    )
      throw new Error("policy requires undeclared scope");
  }
  if (app.runtime && !policies.length)
    throw new Error("runtime must declare at least one policy action");
  for (const field of ["streamPath", "resumePath", "cancelPath", "statusPath"]) {
    const path = ui.assistant?.[field];
    if (!path) continue;
    const policy = resolveAgenticAppHttpPolicyAction(app, "POST", path);
    if (!policy || policy.defaultEffect !== "allow")
      throw new Error(`assistant ${field} requires an allowed POST policy`);
  }
  record(app.provides, ["mcp", "agents", "workflows"], "provides");
  for (const kind of ["mcp", "agents", "workflows"])
    strings(app.provides[kind], `provides.${kind}`);
  record(app.consumes, ["platformApis"], "consumes");
  for (const api of list(app.consumes.platformApis, "consumes.platformApis")) {
    record(api, ["id", "version", "required"], "consumes.platformApi");
    string(api.id, "consumes.platformApi.id");
    string(api.version, "consumes.platformApi.version");
    boolean(api.required, "consumes.platformApi.required");
    if (
      api.required &&
      (!HOST_APIS.has(api.id) ||
        api.version !== "1.0" ||
        (api.id !== "app.gateway" && api.id !== "host.notifications" && !modes.has("native-package")))
    )
      throw new Error(
        `unsupported required platform capability: ${api.id}@${api.version}`,
      );
    if (api.required && api.id === "app.gateway" && !app.runtime)
      throw new Error(
        "required app.gateway capability needs a runtime binding",
      );
  }
  for (const permission of list(
    app.requestedPermissions,
    "requestedPermissions",
  )) {
    record(
      permission,
      ["resourceType", "resourceRef", "actions"],
      "requestedPermission",
    );
    string(permission.resourceType, "requestedPermission.resourceType");
    string(permission.resourceRef, "requestedPermission.resourceRef");
    if (!strings(permission.actions, "requestedPermission.actions").length)
      throw new Error("permission request requires an action");
  }
  if (app.health !== undefined) {
    record(app.health, ["endpoint", "timeoutMs"], "health");
    pathValue(app.health.endpoint, "health.endpoint");
    if (
      app.health.timeoutMs !== undefined &&
      (!Number.isFinite(app.health.timeoutMs) || app.health.timeoutMs <= 0)
    )
      throw new Error("invalid health timeout");
  }
  if (app.catalog !== undefined) {
    record(
      app.catalog,
      ["categories", "capabilities", "icon", "supportUrl"],
      "catalog",
    );
    for (const field of ["categories", "capabilities"])
      if (app.catalog[field] !== undefined)
        strings(app.catalog[field], `catalog.${field}`);
    if (app.catalog.icon !== undefined) {
      const icon = string(app.catalog.icon, "catalog.icon");
      // Legacy symbolic icons remain valid and render the generic app mark.
      if (!resolveAgenticAppIcon(app.id, icon) && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(icon))
        throw new Error("catalog.icon must be an asset under /app-icons/<app-id>/ or a legacy icon name");
    }
    if (app.catalog.supportUrl !== undefined) {
      const url = new URL(string(app.catalog.supportUrl, "catalog.supportUrl"));
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("invalid supportUrl");
    }
  }
  return app;
}

/** Existing deployment manifests have already passed the legacy config parser. */
/** Shared publisher/runtime policy matching, including first-match denial. */
export function resolveAgenticAppHttpPolicyAction(manifest, method, path) {
  const normalize = (value) => {
    const absolute = value.startsWith("/") ? value : `/${value}`;
    return absolute.length > 1 ? absolute.replace(/\/+$/, "") : absolute;
  };
  const normalizedMethod = method.toUpperCase();
  const actual = normalize(path).split("/").filter(Boolean);
  const policies = manifest.access.policyActions;
  const route = policies.find((candidate) => {
    if (candidate.method !== normalizedMethod || typeof candidate.path !== "string") return false;
    const expected = normalize(candidate.path).split("/").filter(Boolean);
    return expected.length === actual.length && expected.every(
      (segment, index) => segment.startsWith(":") || segment === actual[index],
    );
  });
  if (route) return route;
  if (policies.some((candidate) => candidate.method === normalizedMethod)) return undefined;
  return policies.find((candidate) => candidate.action === `proxy:${normalizedMethod}`);
}

export function normalizeLegacyAgenticAppManifest(legacy) {
  return {
    ...legacy,
    apiVersion: "2.0",
    ui: {
      profiles: [{ id: "hosted", mode: "iframe" }],
      routes: [{ id: "home", path: `/apps/${legacy.id}` }],
    },
    api: { mounts: [] },
    ...emptyCapabilities(),
  };
}

/** Preserve the declared component contract when adapting a standalone UI descriptor. */
export function normalizeNativeExtensionManifest(legacy, packageName, version) {
  const contractVersion =
    legacy.contractVersion ?? LEGACY_NATIVE_CONTRACT_VERSION;
  if (!isSupportedNativeContractVersion(contractVersion)) {
    throw new Error("unsupported native component contract version");
  }
  return {
    id: legacy.id,
    displayName: legacy.displayName,
    description: legacy.description,
    apiVersion: "2.0",
    ...(version ? { version } : {}),
    ui: {
      profiles: [
        {
          id: "native",
          mode: "native-package",
          package: packageName,
          contractVersion,
        },
      ],
      routes: legacy.hostPaths.map((path, index) => ({
        id: `route-${index}`,
        path,
      })),
      ...(legacy.slots ? { slots: legacy.slots } : {}),
      ...(legacy.navigation
        ? {
            navigation: {
              ...legacy.navigation,
              routeRef: `route-${legacy.hostPaths.findIndex((path) => legacy.navigation.href === path || legacy.navigation.href.startsWith(`${path}/`))}`,
            },
          }
        : {}),
      ...(legacy.assistant ? { assistant: legacy.assistant } : {}),
    },
    api: { mounts: legacy.api.mounts },
    auth: legacy.auth,
    surfaces: { showInHub: false },
    access: { tokenScopes: [], policyActions: [] },
    ...emptyCapabilities(),
  };
}

/** Project the shared record onto the unchanged native component interface. */
export function nativeUiDescriptor(app) {
  const profile = app.ui.profiles.find(
    (candidate) => candidate.mode === "native-package",
  );
  if (!profile) return null;
  const navigation = app.ui.navigation;
  const route = app.ui.routes.find(
    (candidate) => candidate.id === navigation?.routeRef,
  );
  return {
    id: app.id,
    displayName: app.displayName,
    description: app.description,
    contractVersion: profile.contractVersion,
    hostPaths: app.ui.routes.map((candidate) => candidate.path),
    ...(app.ui.slots ? { slots: app.ui.slots } : {}),
    ...(navigation
      ? {
          navigation: {
            label: navigation.label,
            href: navigation.href ?? route.path,
            placement: navigation.placement,
            ...(navigation.icon ? { icon: navigation.icon } : {}),
          },
        }
      : {}),
    ...(app.ui.assistant ? { assistant: app.ui.assistant } : {}),
    api: {
      appId: app.id,
      basePath: `/api/agentic-apps/runtime/${app.id}`,
      mounts: app.api.mounts,
    },
    auth: app.auth,
  };
}

export function validateAgenticAppOwnership(manifests) {
  const ids = new Set();
  const claims = [];
  for (const app of manifests) {
    if (ids.has(app.id)) throw new Error(`duplicate application id: ${app.id}`);
    ids.add(app.id);
    for (const route of app.ui.routes)
      claims.push({ id: app.id, kind: "route", path: route.path });
    for (const mount of app.api.mounts)
      claims.push({ id: app.id, kind: "api", path: mount });
    for (const slot of app.ui.slots ?? [])
      claims.push({ id: app.id, kind: "slot", path: slot });
  }
  const owners = new Map();
  for (const claim of claims) {
    const key = `${claim.kind}:${claim.path}`;
    if (owners.has(key))
      throw new Error(
        `application claims overlap: ${owners.get(key)}/${claim.id} at ${claim.path}`,
      );
    owners.set(key, claim.id);
  }
  for (const claim of claims) {
    if (claim.kind === "slot") continue;
    let ancestor = claim.path;
    while (ancestor.lastIndexOf("/") > 0) {
      ancestor = ancestor.slice(0, ancestor.lastIndexOf("/"));
      const owner = owners.get(`${claim.kind}:${ancestor}`);
      if (owner)
        throw new Error(
          `application claims overlap: ${owner}/${claim.id} at ${claim.path}`,
        );
    }
  }
}
