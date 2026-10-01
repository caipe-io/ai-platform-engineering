import type {
  NativeExtensionManifest,
  NativeExtensionModule,
} from "../../native-extension-sdk";

export type {
  NativeExtensionBreadcrumb,
  NativeExtensionManifest,
  NativeExtensionModule,
  NativeExtensionProps,
} from "../../native-extension-sdk";

export interface InstalledNativeExtension {
  manifest: NativeExtensionManifest;
  module: NativeExtensionModule;
}
