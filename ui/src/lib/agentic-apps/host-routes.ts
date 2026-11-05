import type { ConfiguredAgenticApp } from "@/types/agentic-app";

export function ownsAppPath(root: string, pathname: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

/** Compiled native routes keep their contract; iframe takeover requires operator approval. */
export function agenticAppHostPaths(app: ConfiguredAgenticApp): string[] {
  if (!app.installation.installed || !app.installation.enabled) return [];
  const profile = app.manifest.ui.profiles.find(p => p.id === app.installation.selectedUiProfile);
  return profile?.mode === "native-package"
    ? app.manifest.ui.routes.map(route => route.path)
    : app.installation.hostRouteClaims ?? [];
}

export function agenticAppForHostPath(apps: ConfiguredAgenticApp[], pathname: string): ConfiguredAgenticApp | null {
  const matches = apps.filter(app => agenticAppHostPaths(app).some(root => ownsAppPath(root, pathname)));
  if (matches.length > 1) throw new Error("Multiple applications own this host route");
  return matches[0] ?? null;
}
