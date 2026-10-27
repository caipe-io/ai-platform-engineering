export type HarnessRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface HarnessRun {
  run_id: string;
  agent_id: string;
  conversation_id: string;
  agent_version: number;
  binding_id: string;
  harness_id: string;
  profile_id: string;
  status: HarnessRunStatus;
  last_sequence: number;
}

export interface HarnessRunEvent {
  run_id: string;
  sequence: number;
  event_type:
    | "run.started"
    | "session.updated"
    | "content.delta"
    | "reasoning.delta"
    | "tool.started"
    | "tool.completed"
    | "interrupt.requested"
    | "subagent.started"
    | "subagent.event"
    | "usage.updated"
    | "run.completed"
    | "run.failed"
    | "run.cancelled";
  data: Record<string, unknown>;
}

export type HarnessCapabilityLevel = "native" | "emulated" | "unsupported" | "unavailable";

export interface HarnessCapability {
  level: HarnessCapabilityLevel;
  explanation: string;
  constraints: Record<string, unknown>;
}

export interface HarnessProfile {
  id: string;
  harness_id: string;
  display_name: string;
  description: string;
  available: boolean;
}

export interface HarnessDescriptor {
  id: string;
  display_name: string;
  adapter_version: string;
  contract_version: number;
  execution_mode: "provider_managed" | "sandbox_pod" | "in_process";
  availability: "available" | "misconfigured" | "unavailable";
  certification: "experimental" | "certified" | "blocked";
  profiles: HarnessProfile[];
  options_schema: {
    type: "object";
    properties?: Record<string, HarnessOptionSchema>;
    required?: string[];
  };
  ui_schema: Record<string, unknown>;
  capabilities: Record<string, HarnessCapability>;
}

export interface HarnessOptionSchema {
  type: "string" | "integer" | "number" | "boolean";
  title?: string;
  description?: string;
  default?: string | number | boolean;
  enum?: Array<string | number>;
  minimum?: number;
  maximum?: number;
}

export interface HarnessCatalog {
  contract_version: number;
  catalog_revision: string;
  harnesses: HarnessDescriptor[];
}

export interface AgentBlueprint {
  id: string;
  name: string;
  description: string;
  harness: { id: string; profile_id: string; options: Record<string, unknown> };
  prompt: { system: string; variables: Record<string, string>; context_sources: string[] };
  model: { policy: "harness_default" | "configured"; id?: string; provider?: string };
  tools: {
    bindings: Array<{ tool_id: string }>;
    approval_policy: "never" | "sensitive_only" | "always";
  };
  thread: { persistence: "durable" | "ephemeral" };
  memory: { enabled: boolean };
  workspace: { persistence: "none" | "run" | "thread" };
  streaming: { protocol: "canonical"; replay: "required" | "best_effort" };
  delegation: { agents: string[]; max_depth: number; max_parallel: number };
}

export interface HarnessEventPage {
  run: HarnessRun;
  events: HarnessRunEvent[];
  next_cursor: number;
}

export interface HarnessSessionBinding {
  binding_id: string;
  agent_id: string;
  agent_version: number;
  conversation_id: string;
  harness_id: string;
  profile_id: string;
  provider_session_id?: string | null;
  checkpoint_strategy: "langgraph" | "adapter_store" | "remote_managed" | "ephemeral";
  epoch: number;
  revision: number;
  status: "active" | "degraded" | "closed";
}

export interface ClearHarnessSessionResult {
  cleared: boolean;
  closed_binding_id?: string | null;
  next_epoch: number;
}
