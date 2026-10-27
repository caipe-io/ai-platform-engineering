import type { NativeExtensionManifest } from "./types";

export function isSafeHostHref(href: string): boolean {
  return href.startsWith("/")
    && !href.startsWith("//")
    && !href.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(href);
}

export function filterAccessibleNativeNavigation(
  manifests: NativeExtensionManifest[],
  accessibleIds: ReadonlySet<string>,
): NativeExtensionManifest[] {
  return manifests.filter(
    (manifest) => Boolean(manifest.navigation) && accessibleIds.has(manifest.id),
  );
}
