"use client";

import { nativeExtensionForSlot } from "./runtime";
import { NativeExtensionHost } from "./NativeExtensionHost";

export function NativeExtensionSlot({ name }: { name: "home" }): React.ReactElement | null {
  const extension = nativeExtensionForSlot(name);
  if (!extension) return null;
  return <NativeExtensionHost extensionId={extension.id} slot />;
}
