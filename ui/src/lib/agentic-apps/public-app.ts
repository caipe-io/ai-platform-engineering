import { agenticAppHostPaths, ownsAppPath } from "./host-routes";

import type {
  ConfiguredAgenticApp,
  PublicAgenticApp,
} from "@/types/agentic-app";
import { resolveAgenticAppIcon } from "../../../app-sdk/agentic-app-manifest.mjs";

/** Build the browser-safe catalog record. Runtime origins never cross the BFF. */
export function buildPublicAgenticApp(
  app: ConfiguredAgenticApp,
  canLaunch: boolean,
): PublicAgenticApp {
  const icon = resolveAgenticAppIcon(app.manifest.id, app.manifest.catalog?.icon);
  return {
    appId: app.installation.appId,
    assistantEnabled: Boolean(app.manifest.ui.assistant),
    ...(app.manifest.ui.assistant ? {
      assistantOverlay: app.manifest.ui.assistant.overlay ?? "host",
      assistantAgentId: app.manifest.ui.assistant.agentId,
      assistantLabel: app.manifest.ui.assistant.label,
      assistantAgentName: app.manifest.ui.assistant.name,
    } : {}),
    ...(app.manifest.ui.navigation && app.installation.navigationOverrides?.visible !== false ? {
      navigation: {
        label: app.installation.navigationOverrides?.label ?? app.manifest.ui.navigation.label,
        href: agenticAppEntryHref(app),
        icon: app.manifest.ui.navigation.icon,
        order: app.installation.navigationOverrides?.order ?? app.manifest.surfaces.navOrder,
      },
    } : {}),
    displayName: app.manifest.displayName,
    ...(icon ? { icon } : {}),
    description: app.manifest.description,
    href: agenticAppEntryHref(app),
    canLaunch,
    blockedReasons: canLaunch ? [] : ["unauthorized"],
    categories: app.manifest.catalog?.categories ?? [],
    capabilities: app.manifest.catalog?.capabilities ?? [],
    uiMode: app.manifest.ui.profiles.find(
      (profile) => profile.id === app.installation.selectedUiProfile,
    )?.mode,
    hostPaths: agenticAppHostPaths(app),
  };
}

export function agenticAppEntryHref(app: ConfiguredAgenticApp): string {
  const profile = app.manifest.ui.profiles?.find(
    (candidate) => candidate.id === app.installation.selectedUiProfile,
  );
  const hostPaths = agenticAppHostPaths(app);
  if (profile?.mode !== "native-package" && !hostPaths.length)
    return `/apps/${encodeURIComponent(app.installation.appId)}`;
  const navigation = app.manifest.ui.navigation;
  const href = (
    navigation?.href ??
    app.manifest.ui.routes.find((route) => route.id === navigation?.routeRef)
      ?.path ??
    app.manifest.ui.routes[0]?.path ??
    "/"
  );
  return hostPaths.some(root => ownsAppPath(root, href)) ? href : hostPaths[0] ?? `/apps/${app.installation.appId}`;
}

/** Retain owned deep links when the legacy /apps entry selects native UI. */
export function nativeAgenticAppDestination(
  app: PublicAgenticApp,
  path: string[],
  search: string,
): string {
  const owns = (candidate: string) =>
    app.hostPaths?.some(
      (root) => candidate === root || candidate.startsWith(`${root}/`),
    );
  let target = app.href;
  if (
    path.length &&
    !path.some((part) => part === "." || part === ".." || /[\\/]/.test(part))
  ) {
    const suffix = path.map(encodeURIComponent).join("/");
    const canonical = `/${suffix}`;
    const root = app.hostPaths?.find(
      (root) => app.href === root || app.href.startsWith(`${root}/`),
    );
    if (owns(canonical)) target = canonical;
    else if (root) target = `${root}/${suffix}`;
  }
  return `${target}${search ? `?${search}` : ""}`;
}
