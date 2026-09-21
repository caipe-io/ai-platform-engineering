/**
 * @jest-environment node
 */

const mockGetCollection = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

import type { WorkflowConfig, WorkflowStep } from "@/types/workflow-config";
import { assertWorkflowConfigRunnable } from "../workflow-step-agents";

function step(configOverride?: Record<string, unknown> | null): WorkflowStep {
  return {
    type: "step",
    display_text: "Run step",
    agent_id: "agent-a",
    prompt: "Do the thing",
    on_error: "abort",
    config_override: configOverride,
  };
}

function config(configOverride?: Record<string, unknown> | null): WorkflowConfig {
  return {
    _id: "workflow-a",
    name: "Workflow A",
    steps: [step(configOverride)],
    owner_id: "owner@example.com",
    visibility: "private",
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function mockAgents(agents: Array<Record<string, unknown>>): void {
  const toArray = jest.fn().mockResolvedValue(agents);
  const project = jest.fn().mockReturnValue({ toArray });
  mockGetCollection.mockResolvedValue({
    find: jest.fn().mockReturnValue({ project }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("assertWorkflowConfigRunnable", () => {
  it("allows a tool override that is a subset of the base agent", async () => {
    mockAgents([
      {
        _id: "agent-a",
        allowed_tools: { "mcp-primary": ["search", "get"] },
      },
    ]);

    await expect(
      assertWorkflowConfigRunnable(
        config({ allowed_tools: { "mcp-primary": ["search"] } }),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a stale server ID before the workflow can run", async () => {
    mockAgents([
      {
        _id: "agent-a",
        allowed_tools: { "mcp-primary": true },
      },
    ]);

    await expect(
      assertWorkflowConfigRunnable(config({ allowed_tools: { primary: false } })),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "WORKFLOW_TOOL_OVERRIDE_INVALID",
      message: expect.stringContaining("unknown server(s): primary"),
    });
  });

  it("rejects tools that are not present in a list-based base server", async () => {
    mockAgents([
      {
        _id: "agent-a",
        allowed_tools: { "mcp-primary": ["search"] },
      },
    ]);

    await expect(
      assertWorkflowConfigRunnable(
        config({ allowed_tools: { "mcp-primary": ["delete"] } }),
      ),
    ).rejects.toThrow("unknown tools: delete");
  });

  it("rejects re-enabling a server disabled on the base agent", async () => {
    mockAgents([
      {
        _id: "agent-a",
        allowed_tools: { "mcp-primary": false },
      },
    ]);

    await expect(
      assertWorkflowConfigRunnable(
        config({ allowed_tools: { "mcp-primary": ["search"] } }),
      ),
    ).rejects.toThrow("server is disabled on the base agent");
  });

  it("rejects missing workflow agents", async () => {
    mockAgents([]);

    await expect(assertWorkflowConfigRunnable(config())).rejects.toMatchObject({
      statusCode: 400,
      code: "WORKFLOW_AGENT_NOT_FOUND",
    });
  });
});
