export interface MessageActionDialog {
  title: string;
  description?: string;
  submitLabel: string;
  field: { label: string; prefill: "message" | "empty"; optional: boolean; maxLength: number };
}
export interface MessageActionDeclaration {
  id: string;
  label: string;
  icon: "flag" | "bookmark" | "check" | "star" | "clipboard" | "send";
  /** App-relative runtime path the host calls through its BFF. */
  path: string;
  dialog?: MessageActionDialog;
}
/** Declarative extension points; identity and routing are never app options. */
export interface AssistantOptions {
  version: "1.0";
  requireConfiguration?: boolean;
  includeLegacyAgentHistory?: boolean;
  legacyConversationQueryParams?: string[];
  controls?: Array<{
    id: string; label: string; requestKey: string; defaultChoice: string;
    kind?: "select" | "checkbox";
    choices: Array<{ id: string; label: string; value?: string | boolean | number }>;
  }>;
  messageActions?: MessageActionDeclaration[];
  presentation?: {
    placeholder?: string;
    showAuditNotice?: boolean;
    feedbackPrompt?: { message: string; actionLabel: string; trailingText?: string };
    fontScale?: "compact" | "default" | "large";
    width?: number; height?: number;
    showSuggestions?: boolean;
    suggestedPrompts?: string[];
  };
}
export interface AssistantConfiguration {
  version: "1.0";
  visible: boolean;
  bottomInset?: number;
  controls?: Record<string, { choices: string[]; defaultChoice: string }>;
  /** Per-user visibility only; never an authorization grant. */
  messageActions?: Record<string, { visible: boolean }>;
}
export const MESSAGE_ACTION_ICONS: readonly string[];
export const MAX_MESSAGE_ACTIONS: number;
export const MAX_MESSAGE_ACTION_LABEL: number;
export const MAX_MESSAGE_ACTION_TEXT: number;
export const ASSISTANT_EXTENSIONS: readonly string[];
export function validateAssistantOptions(value: unknown): asserts value is AssistantOptions;
export function validateAssistantConfiguration(value: unknown, options?: AssistantOptions): asserts value is AssistantConfiguration;
export function validateAssistantRequestOptions(value: unknown, options: AssistantOptions): void;
