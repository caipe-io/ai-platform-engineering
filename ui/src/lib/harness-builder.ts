import type { HarnessDescriptor } from "@/types/harness-engine";

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
  if (!descriptor || descriptor.ui_schema.version === undefined) return [];
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
