import type { AppAssistantContext } from "./index.js";
export const INTERFACE_SHADOWS_CSS: string;
export interface AgenticAppBridgeCapabilities {
  /** Metadata from the running host, never the application's build baseline. */
  hostBuild?: { version: string | null; gitCommit: string | null };
  assistantOptions?: import("./assistant-options.mjs").AssistantOptions;
  assistant: boolean;
  assistantDraft?: boolean;
  context: boolean;
  navigation: boolean;
  queryNavigation?: boolean;
  pathNavigation?: boolean;
  breadcrumbs?: boolean;
  breadcrumbPresentation?: boolean;
  hostShortcuts?: Array<"search">;
  composerExtensions: string[];
}
export interface AgenticAppBridge {
  getCapabilities(): AgenticAppBridgeCapabilities | null;
  configureAssistant(configuration: import("./assistant-options.mjs").AssistantConfiguration): void;
  closeAssistant(): void;
  openAssistant(context?: AppAssistantContext, draft?: AssistantDraft): void;
  setContext(context: AppAssistantContext): void;
  navigate(href: string, options?: { history?: "push" | "replace" }): void;
  setBreadcrumbs(breadcrumbs: Array<{ label: string; href?: string; tone?: "primary" | "info"; icon?: "target" | "layers" }>, route: string): void;
  dispose(): void;
}
export function createAgenticAppBridge(options: {
  appId: string;
  onAssistantState?: (open: boolean) => void;
  onNavigate?: (href: string) => void;
  onStatus?: (status: string, capabilities?: AgenticAppBridgeCapabilities) => void;
  timeoutMs?: number;
}): AgenticAppBridge;

export type AssistantDraft = { id: string; text: string; attachment?: { name: string; content: string; mimeType: "text/markdown" } };
export function parseAssistantDraft(value: unknown): AssistantDraft | null;
