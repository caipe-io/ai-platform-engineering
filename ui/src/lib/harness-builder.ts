import type { HarnessDescriptor } from "@/types/harness-engine";

/** Integration maturity is separate from runtime configuration and access. */
export function harnessStatusLabel(id: string, certification?: HarnessDescriptor["certification"]): string {
  if (certification === "blocked") return "Blocked";
  return id === "dynamic_agents" ? "Stable" : "Experimental";
}

export function harnessDisplayName(descriptor: Pick<HarnessDescriptor, "id" | "display_name">): string {
  return ({ claude_agent_sdk: "Claude Agent SDK", claude_agent_sdk_remote: "Claude Agent SDK",
    claude_code_cli_acp: "Claude Code", claude_code_acp: "Claude Agent SDK (Advanced ACP)" } as Record<string, string>)[descriptor.id] ?? descriptor.display_name;
}

/** Presentation groups never replace the runtime/profile IDs persisted in blueprints. */
export function harnessFamily(id: string): string {
  return id === "claude_agent_sdk_remote" ? "claude_agent_sdk" : id;
}

export function selectableHarness(descriptor: HarnessDescriptor): boolean {
  return descriptor.availability === "available" && descriptor.certification !== "blocked";
}

export function harnessChoices(descriptors: HarnessDescriptor[], advanced: boolean, currentId: string): HarnessDescriptor[] {
  const families = new Map<string, HarnessDescriptor>();
  for (const descriptor of descriptors) {
    if (descriptor.id === "dynamic_agents" || (descriptor.id === "claude_code_acp" && !advanced && currentId !== descriptor.id)) continue;
    const family = harnessFamily(descriptor.id);
    const previous = families.get(family);
    if (!previous || (!selectableHarness(previous) && selectableHarness(descriptor))) families.set(family, descriptor);
  }
  return [...families.values()];
}

export function harnessProfileChoices(descriptors: HarnessDescriptor[], id: string) {
  return descriptors.filter(descriptor => harnessFamily(descriptor.id) === harnessFamily(id)).flatMap(descriptor =>
    descriptor.profiles.map(profile => ({
      runtimeId: descriptor.id, profileId: profile.id,
      value: harnessFamily(id) === "claude_agent_sdk" ? JSON.stringify([descriptor.id, profile.id]) : profile.id,
      label: profile.display_name + (harnessFamily(id) === "claude_agent_sdk" ? ` · ${descriptor.id === "claude_agent_sdk" ? "Local" : "Remote worker"}` : ""),
      available: selectableHarness(descriptor) && profile.available,
    })));
}

export const HARNESS_RENDERERS = [
  "agent-delegation", "deep-agents-middleware", "remote-agents", "tool-approvals", "workflow-tools", "schema-form",
] as const;
export type HarnessRenderer = typeof HARNESS_RENDERERS[number];
const RENDERER_PATHS: Record<HarnessRenderer, string> = {
  "agent-delegation": "/delegation", "deep-agents-middleware": "/harness/options/runtime/features",
  "remote-agents": "/tools", "tool-approvals": "/tools", "workflow-tools": "/tools", "schema-form": "/harness/options",
};

export interface BuilderSection {
  id: string;
  title: string;
  step: string;
  requires: string[];
  renderer: HarnessRenderer;
  valuePath: string;
}

const LEGACY_CAPABILITIES = new Set([
  "tools.broker", "tools.builtin", "knowledge", "skills", "model.configured", "multi_agent.delegation",
  "deep_agents.middleware", "remote_agents", "human_input.resume", "workflows",
]);

export function supportsHarnessCapability(descriptor: HarnessDescriptor | undefined, capability: string, legacy = false): boolean {
  if (!descriptor) return legacy && LEGACY_CAPABILITIES.has(capability);
  const level = descriptor.capabilities[capability]?.level;
  return level === "native" || level === "emulated";
}

export function harnessBuilderSections(descriptor: HarnessDescriptor | undefined): BuilderSection[] {
  if (!descriptor) return [];
  if (descriptor.ui_schema.version === undefined) {
    const legacy: Array<[HarnessRenderer, string, string]> = [
      ["agent-delegation", "multi_agent.delegation", "Agent delegation"],
      ["deep-agents-middleware", "deep_agents.middleware", "Middleware"],
      ["remote-agents", "remote_agents", "Remote agents"],
      ["tool-approvals", "human_input.resume", "Tool approvals"],
      ["workflow-tools", "workflows", "Workflow tools"],
    ];
    return legacy.filter(([, capability]) => supportsHarnessCapability(descriptor, capability)).map(([renderer, capability, title]) => ({
      id: renderer, renderer, title, step: "advanced", requires: [capability], valuePath: RENDERER_PATHS[renderer],
    }));
  }
  if (descriptor.ui_schema.version !== 1) throw new Error("Unsupported harness editor schema version");
  const sections = descriptor.ui_schema.sections;
  if (!Array.isArray(sections) || sections.length > 32) throw new Error("Unsupported harness editor schema");
  const ids = new Set<string>();
  return sections.map((section: unknown) => {
    if (!section || typeof section !== "object") throw new Error("Invalid harness editor section");
    const item = section as BuilderSection;
    if (!HARNESS_RENDERERS.includes(item.renderer) || !Array.isArray(item.requires) ||
        item.requires.some(value => typeof value !== "string") || typeof item.id !== "string" ||
        typeof item.title !== "string" || item.title.length > 128 || item.step !== "advanced" ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(item.id) || ids.has(item.id) ||
        RENDERER_PATHS[item.renderer] !== item.valuePath) {
      throw new Error("The harness requires an unsupported editor section");
    }
    ids.add(item.id);
    return item;
  });
}

/** Bounded schema subset understood by the host form; adapters still validate values. */
export function validateHarnessOptionsSchema(schema: Record<string, unknown>, depth = 0): void {
  if (depth > 6 || ["$ref", "oneOf", "anyOf", "allOf"].some(key => schema[key] !== undefined)) throw new Error("Unsupported harness option schema");
  const type = schema.type ?? "object";
  if (!["object", "array", "string", "integer", "number", "boolean"].includes(String(type)) || Array.isArray(type)) throw new Error("Unsupported harness option type");
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length > 100)) throw new Error("Too many harness option choices");
  if (type === "object") {
    const properties = schema.properties ?? {};
    if (!properties || typeof properties !== "object" || Array.isArray(properties) || Object.keys(properties).length > 64) throw new Error("Too many harness options");
    for (const child of Object.values(properties)) {
      if (!child || typeof child !== "object" || Array.isArray(child)) throw new Error("Invalid harness option schema");
      validateHarnessOptionsSchema(child as Record<string, unknown>, depth + 1);
    }
  } else if (type === "array") {
    if (!schema.items || typeof schema.items !== "object" || Array.isArray(schema.items)) throw new Error("Harness arrays require an item schema");
    validateHarnessOptionsSchema(schema.items as Record<string, unknown>, depth + 1);
  }
}
