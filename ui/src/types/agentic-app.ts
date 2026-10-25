import type { AgenticAppManifest, AgenticAppAuthMode, AgenticAppPolicyAction } from "../../app-sdk/agentic-app-manifest.mjs";

export type { AgenticAppManifest, AgenticAppUiProfile, AgenticAppAuthMode, AgenticAppPolicyAction } from "../../app-sdk/agentic-app-manifest.mjs";
export type AgenticAppRuntimeKind = "proxied-next-zone";

export const DEFAULT_AGENTIC_APP_MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
export const MAX_AGENTIC_APP_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

/** Compatibility input for existing hosted deployments. */
export interface LegacyAgenticAppManifest {
  id: string;
  displayName: string;
  description: string;
  apiVersion: "1.0";
  auth: {
    mode: AgenticAppAuthMode;
  };
  runtime: {
    kind: AgenticAppRuntimeKind;
    origin?: string;
    mountPath: string;
    preserveMountPath?: boolean;
    chrome?: "iframe";
    maxRequestBodyBytes?: number;
  };
  surfaces: {
    showInHub: boolean;
    navOrder?: number;
    homeEligible?: boolean;
  };
  access: {
    requiredRoles?: string[];
    tokenScopes: string[];
    policyActions: AgenticAppPolicyAction[];
  };
  health?: {
    endpoint: string;
    timeoutMs?: number;
  };
  catalog?: {
    categories?: string[];
    capabilities?: string[];
    icon?: string;
    supportUrl?: string;
  };
}

export interface AgenticAppInstallation {
  appId: string;
  packageId: string;
  installed: boolean;
  enabled: boolean;
  visible: boolean;
  selectedUiProfile?: string;
  appVersion?: string;
  bindings?: {
    runtimeOrigin?: string;
    resources?: Record<string, string>;
    /** Client id of the service account this app uses to call the host. */
    serviceAccountClientId?: string;
  };
  runtimeMountPath?: string;
  runtimeOriginOverride?: string;
  accessOverrides?: {
    requiredRoles?: string[];
  };
}

export interface ConfiguredAgenticApp {
  manifest: AgenticAppManifest;
  installation: AgenticAppInstallation;
}

export interface PublicAgenticApp {
  appId: string;
  icon?: string;
  displayName: string;
  description: string;
  href: string;
  canLaunch: boolean;
  blockedReasons: string[];
  categories: string[];
  capabilities: string[];
  uiMode?: "native-package" | "iframe";
  hostPaths?: string[];
  assistantEnabled?: boolean;
  assistantAgentId?: string;
  assistantLabel?: string;
  assistantAgentName?: string;
}

export interface AgenticAppAssistantContextRecord {
  contextId: string;
  appId: string;
  sessionId: string;
  schemaVersion: string;
  route: string;
  payloadSizeBytes: number;
  validationStatus: "accepted" | "ignored" | "rejected";
  createdAt: string;
  expiresAt: string;
  title?: string;
  summary?: string;
  selection?: string;
  resourceRefs?: Array<Record<string, string>>;
  suggestedPrompts?: string[];
  reasonCode?: string;
}
