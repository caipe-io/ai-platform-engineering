import type { ComponentType } from "react";
import type Link from "next/link";
import type { NativeExtensionContractVersion } from "./contract-version.mjs";

export type { NativeExtensionContractVersion } from "./contract-version.mjs";
export { CONTRACT_VERSION, CHECKER_VERSION, LEGACY_NATIVE_CONTRACT_VERSION, isSupportedNativeContractVersion } from "./contract-version.mjs";

export type { AgenticAppManifest, AgenticAppUiProfile, AgenticAppAuthMode, AgenticAppPolicyAction } from "./agentic-app-manifest.mjs";
export { validateAgenticAppManifest, validateAgenticAppOwnership } from "./agentic-app-manifest.mjs";
export type { NativeExtensionManifest } from "./native-manifest.mjs";

export interface NativeExtensionBreadcrumb {
  label: string;
  href?: string;
}

export interface NativeExtensionProps {
  apiBasePath: string;
  pathname: string;
  search: string;
  navigate: (href: string) => void;
  Link?: typeof Link;
  setBreadcrumbs: (breadcrumbs: NativeExtensionBreadcrumb[]) => void;
  chat?: NativeHostChat;
}

export interface NativeExtensionModule {
  Component: ComponentType<NativeExtensionProps>;
  /** Must equal the manifest profile's version; new publishers use 2.0. */
  contractVersion: NativeExtensionContractVersion;
}

/** Host owns streaming, history persistence and activity across native screens. */
export interface NativeHostChat {
  /** Optional: request the host-owned popup instead of bundling an overlay. */
  assistant?: HostAssistantCapability;
  Panel: ComponentType<NativeHostChatPanelProps>;
  /** Optional controls reuse host sharing and recoverable archive. */
  ConversationActions?: ComponentType<NativeHostConversationActionsProps>;
}
export interface NativeHostConversationActionsProps {
  conversationId: string;
  agentId: string;
  disabled?: boolean;
  onArchived: () => void;
  /** Legacy hook for hosts that also expose archive restoration. */
  onHistoryChange?: () => void;
}
export interface NativeHostChatPanelProps {
  conversationId: string;
  agentId: string;
  agentName?: string;
  clientContext?: Record<string, unknown>;
  requestOptions?: Record<string, unknown>;
  composerHeader?: import("react").ReactNode;
  placeholder?: string;
  emptyStateTitle?: string;
  /** Whether to show the agent identity row. Defaults to true; embedded surfaces may opt out. */
  showAgentHeader?: boolean;
  /** Show the configured audit logging notice. Defaults to true; does not change audit logging. */
  showAuditNotice?: boolean;
  /** App-owned copy linking to the host feedback form when reporting is enabled. */
  feedbackPrompt?: { message: string; actionLabel: string; trailingText?: string };
}

/** User-visible context is untrusted input, never an authorization grant. */
export interface AppAssistantContext {
  route: string;
  title?: string;
  summary?: string;
  selection?: string;
  resourceRefs?: Array<Record<string, string>>;
  suggestedPrompts?: string[];
}
export interface HostAssistantCapability {
  open(context?: AppAssistantContext): void;
  setContext(context: AppAssistantContext): void;
}
