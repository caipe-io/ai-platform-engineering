import { installedNativeExtensionManifests } from "./manifests.generated";
import type { NativeExtensionManifest } from "./types";

function ownsPath(root: string, pathname: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

export function nativeExtensionForHostPath(
  pathname: string,
): NativeExtensionManifest | null {
  return (
    installedNativeExtensionManifests.find((manifest) =>
      manifest.hostPaths.some((path) => ownsPath(path, pathname)),
    ) ?? null
  );
}

export function nativeExtensionForApiPath(
  pathname: string,
): NativeExtensionManifest | null {
  return (
    installedNativeExtensionManifests.find((manifest) =>
      manifest.api.mounts.some((path) => ownsPath(path, pathname)),
    ) ?? null
  );
}

export function nativeExtensionById(
  extensionId: string,
): NativeExtensionManifest | null {
  return (
    installedNativeExtensionManifests.find(
      (manifest) => manifest.id === extensionId,
    ) ?? null
  );
}

export function nativeExtensionForSlot(
  slot: "home",
): NativeExtensionManifest | null {
  return installedNativeExtensionManifests.find(
    (manifest) => manifest.slots?.includes(slot),
  ) ?? null;
}
