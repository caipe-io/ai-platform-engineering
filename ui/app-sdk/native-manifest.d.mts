import type { NativeExtensionContractVersion } from "./contract-version.mjs";

/** Framework-neutral projection consumed by the host's native renderer. */
export interface NativeExtensionManifest {
  id: string;
  displayName: string;
  description: string;
  /** New publishers use 2.0; 1.1 is retained only for compatibility. */
  contractVersion: NativeExtensionContractVersion;
  hostPaths: string[];
  slots?: Array<"home">;
  navigation?: {
    label: string;
    href: string;
    placement: "after-chat";
    icon?: "book-open" | "layout-grid";
  };
  assistant?: { agentId: string; label: string; name: string; streamPath?: string; resumePath?: string; cancelPath?: string; statusPath?: string; overlay?: "host" | "app" };
  api: { appId: string; basePath: string; mounts: string[] };
  auth: { mode: "app-scoped-token" | "forward-user-access-token" };
}
