import type {
  NativeExtensionManifest,
  NativeExtensionModule,
} from "../../app-sdk";

export type {
  NativeExtensionBreadcrumb,
  NativeExtensionManifest,
  NativeExtensionModule,
  NativeExtensionProps,
} from "../../app-sdk";

export interface InstalledNativeExtension {
  manifest: NativeExtensionManifest;
  module: NativeExtensionModule;
}
