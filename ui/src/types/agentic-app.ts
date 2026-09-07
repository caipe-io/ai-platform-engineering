export type AgenticAppRuntimeKind = "proxied-next-zone";

export interface AgenticAppPolicyAction {
  action: string;
  description?: string;
  defaultEffect?: "allow" | "deny";
  reasonCode?: string;
  requiredScopes?: string[];
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  path?: string;
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
}
