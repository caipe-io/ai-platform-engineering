/** Declarative extension points; identity and routing are never app options. */
export interface AssistantOptions {
  version: "1.0";
  requireConfiguration?: boolean;
  includeLegacyAgentHistory?: boolean;
  legacyConversationQueryParams?: string[];
  controls?: Array<{
    id: string; label: string; requestKey: string; defaultChoice: string;
    choices: Array<{ id: string; label: string; value?: string | boolean | number }>;
  }>;
  presentation?: {
    placeholder?: string;
    showAuditNotice?: boolean;
    feedbackPrompt?: { message: string; actionLabel: string; trailingText?: string };
    fontScale?: "compact" | "default" | "large";
    width?: number; height?: number;
  };
}
export interface AssistantConfiguration {
  version: "1.0";
  visible: boolean;
  bottomInset?: number;
  controls?: Record<string, { choices: string[]; defaultChoice: string }>;
}
export const ASSISTANT_EXTENSIONS: readonly string[];
export function validateAssistantOptions(value: unknown): asserts value is AssistantOptions;
export function validateAssistantConfiguration(value: unknown, options?: AssistantOptions): asserts value is AssistantConfiguration;
export function validateAssistantRequestOptions(value: unknown, options: AssistantOptions): void;
