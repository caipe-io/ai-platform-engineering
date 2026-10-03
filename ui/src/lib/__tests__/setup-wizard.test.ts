import {
  isFreshSetupInventory,
  normalizeSetupWizardState,
} from "@/lib/setup-wizard";

describe("setup wizard state", () => {
  it("normalizes persisted progress and drops invalid values", () => {
    expect(normalizeSetupWizardState({
      status: "in_progress",
      current_step: 9,
      completed_steps: [3, 1, 3, 99],
      skipped_steps: [2],
      selection: {
        model_id: " model-primary ",
        model_provider: "openai",
        recipe_id: "sre",
        mcp_server_ids: ["netutils", "netutils", ""],
        enable_knowledge_base: true,
      },
    })).toMatchObject({
      status: "in_progress",
      current_step: 5,
      completed_steps: [1, 3],
      skipped_steps: [2],
      selection: {
        model_id: "model-primary",
        model_provider: "openai",
        recipe_id: "sre",
        mcp_server_ids: ["netutils"],
        enable_knowledge_base: true,
      },
    });
  });

  it("only auto-classifies an unused deployment as fresh", () => {
    const base = {
      agents: 1,
      custom_agents: 0,
      conversations: 0,
      knowledge_sources: 0,
      mcp_servers: 1,
      models: 1,
      users: 1,
    };
    expect(isFreshSetupInventory(base)).toBe(true);
    expect(isFreshSetupInventory({ ...base, conversations: 1 })).toBe(false);
    expect(isFreshSetupInventory({ ...base, custom_agents: 1 })).toBe(false);
    expect(isFreshSetupInventory({ ...base, users: 2 })).toBe(false);
  });
});
