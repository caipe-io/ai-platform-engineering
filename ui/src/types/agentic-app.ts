export type AgenticAppRuntimeKind = "proxied-next-zone";

export const DEFAULT_AGENTIC_APP_MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
export const MAX_AGENTIC_APP_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

export interface AgenticAppPolicyAction {
  action: string;
  description?: string;
  defaultEffect?: "allow" | "deny";
  reasonCode?: string;
  requiredScopes?: string[];
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  path?: string;
}

export interface AgenticAppAssistantConfig {
  enabled?: boolean;
  /** Exact dynamic agent used by this app's contextual chat surface. */
  agentId?: string;
  schemaVersions?: string[];
  maxContextBytes?: number;
  capability?: string;
  suggestions?: boolean;
  label?: string;
  agentName?: string;
}

export interface AgenticAppManifest {
  id: string;
  displayName: string;
  description: string;
  apiVersion: "1.0";
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
  assistant?: AgenticAppAssistantConfig;
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
  displayName: string;
  description: string;
  href: string;
  canLaunch: boolean;
  blockedReasons: string[];
  categories: string[];
  capabilities: string[];
  assistantEnabled: boolean;
  assistantAgentId?: string;
  assistantLabel?: string;
  assistantAgentName?: string;
  assistantMaxContextBytes?: number;
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
