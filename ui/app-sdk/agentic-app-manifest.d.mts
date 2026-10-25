import type { NativeExtensionContractVersion } from "./contract-version.mjs";

export type AgenticAppAuthMode =
  | "app-scoped-token"
  | "forward-user-access-token";
export interface AgenticAppPolicyAction {
  action: string;
  description?: string;
  defaultEffect?: "allow" | "deny";
  reasonCode?: string;
  requiredScopes?: string[];
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  path?: string;
}
export interface AgenticAppUiProfile {
  id: string;
  mode: "native-package" | "iframe";
  package?: string;
  contractVersion?: NativeExtensionContractVersion;
}
export interface AgenticAppManifest {
  id: string;
  displayName: string;
  description: string;
  apiVersion: "2.0";
  version?: string;
  ui: {
    profiles: AgenticAppUiProfile[];
    routes: Array<{ id: string; path: string }>;
    slots?: Array<"home">;
    navigation?: {
      label: string;
      routeRef: string;
      href?: string;
      placement: "after-chat";
      icon?: "book-open" | "layout-grid";
    };
    assistant?: { agentId: string; label: string; name: string; streamPath?: string; resumePath?: string; cancelPath?: string; statusPath?: string; overlay?: "host" | "app" };
  };
  api: { mounts: string[] };
  auth: { mode: AgenticAppAuthMode };
  runtime?: {
    kind: "proxied-next-zone";
    mountPath: string;
    /** Present only in normalized legacy configurations. New origins are installation bindings. */
    origin?: string;
    preserveMountPath?: boolean;
    maxRequestBodyBytes?: number;
    chrome?: "iframe";
  };
  surfaces: { showInHub: boolean; navOrder?: number; homeEligible?: boolean };
  access: {
    requiredRoles?: string[];
    tokenScopes: string[];
    policyActions: AgenticAppPolicyAction[];
  };
  provides: { mcp: string[]; agents: string[]; workflows: string[] };
  consumes: {
    platformApis: Array<{ id: string; version: string; required: boolean }>;
  };
  requestedPermissions: Array<{
    resourceType: string;
    resourceRef: string;
    actions: string[];
  }>;
  health?: { endpoint: string; timeoutMs?: number };
  catalog?: {
    categories?: string[];
    capabilities?: string[];
    /** Same-origin /app-icons/<app-id>/<filename> asset; legacy names use a generic icon. */
    icon?: string;
    supportUrl?: string;
  };
}
export function resolveAgenticAppIcon(appId: string, icon?: string): string | undefined;
export function resolveAgenticAppHttpPolicyAction(
  manifest: AgenticAppManifest,
  method: string,
  path: string,
): AgenticAppPolicyAction | undefined;
export function validateAgenticAppManifest(value: unknown): AgenticAppManifest;
export function normalizeLegacyAgenticAppManifest(
  value: unknown,
): AgenticAppManifest;
export function normalizeNativeExtensionManifest(
  value: unknown,
  packageName: string,
  version?: string,
): AgenticAppManifest;
export function nativeUiDescriptor(
  manifest: AgenticAppManifest,
): import("./native-manifest.mjs").NativeExtensionManifest | null;
export function validateAgenticAppOwnership(
  manifests: AgenticAppManifest[],
): void;
