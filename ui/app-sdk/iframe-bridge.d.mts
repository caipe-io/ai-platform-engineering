import type { AppAssistantContext } from "./index.js";
export interface AgenticAppBridgeCapabilities {
  assistantOptions?: import("./assistant-options.mjs").AssistantOptions;
  assistant: boolean;
  assistantDraft?: boolean;
  context: boolean;
  navigation: boolean;
  composerExtensions: string[];
}
export interface AgenticAppBridge {
  getCapabilities(): AgenticAppBridgeCapabilities | null;
  configureAssistant(configuration: import("./assistant-options.mjs").AssistantConfiguration): void;
  closeAssistant(): void;
  openAssistant(context?: AppAssistantContext, draft?: AssistantDraft): void;
  setContext(context: AppAssistantContext): void;
  navigate(href: string): void;
  dispose(): void;
}
export function createAgenticAppBridge(options: {
  appId: string;
  onAssistantState?: (open: boolean) => void;
  onNavigate?: (href: string) => void;
  onStatus?: (status: string, capabilities?: AgenticAppBridgeCapabilities) => void;
  timeoutMs?: number;
}): AgenticAppBridge;

export type AssistantDraft = { id: string; text: string };
export function parseAssistantDraft(value: unknown): AssistantDraft | null;
