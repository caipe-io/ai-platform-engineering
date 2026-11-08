import { createHash } from "node:crypto";

export const MAX_HANDOFFS = 8;
export const MAX_HANDOFF_DEPTH = 4;
export const HANDOFF_TOOL = "handoff_to_agent";
export const HANDOFF_SCHEMA = {
  type: "object", properties: {
    handle: { type: "string", description: "Joined chat participant handle, without @." },
    message: { type: "string", minLength: 1, maxLength: 8000, description: "Self-contained assignment. Share only the context needed for this task." },
  }, required: ["handle", "message"], additionalProperties: false,
};

export function handoffKey(parentRunId: string, targetAgentId: string, message: string): string {
  return createHash("sha256").update(JSON.stringify([parentRunId, targetAgentId, message])).digest("hex");
}

export function parseHandoff(input: unknown): { handle: string; message: string } {
  const args = input as Record<string, unknown> | null;
  if (!args || Object.keys(args).some(key => !["handle", "message"].includes(key)) ||
      typeof args.handle !== "string" || !/^[a-z][a-z0-9-]{1,31}$/.test(args.handle) ||
      typeof args.message !== "string" || !args.message.trim() || args.message.length > 8000) {
    throw new TypeError("Choose a joined agent handle and a task of 1–8000 characters.");
  }
  return { handle: args.handle, message: args.message.trim() };
}
