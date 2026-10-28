import {
  getDeterministicAgentThemeId,
  getHarnessPresentation,
  normalizeHarnessId,
} from "@/lib/agent-presentation";

describe("agent presentation", () => {
  it("treats missing and legacy runtime ids as LangChain Deep Agents", () => {
    expect(normalizeHarnessId()).toBe("dynamic_agents");
    expect(normalizeHarnessId("langchain-deepagents")).toBe("dynamic_agents");
    expect(getHarnessPresentation().label).toBe("LangChain Deep Agents");
  });

  it("presents provider harnesses with human-readable labels", () => {
    expect(getHarnessPresentation("agentcore").shortLabel).toBe("AgentCore");
    expect(getHarnessPresentation("claude_agent_sdk").label).toBe("Claude Agent SDK");
  });

  it("assigns stable and visibly varied fallback themes by agent id", () => {
    expect(getDeterministicAgentThemeId("agent-alpha")).toBe("sunset");
    expect(getDeterministicAgentThemeId("agent-alpha")).toBe(
      getDeterministicAgentThemeId("agent-alpha"),
    );
    expect(
      new Set([
        getDeterministicAgentThemeId("agent-alpha"),
        getDeterministicAgentThemeId("agent-beta"),
        getDeterministicAgentThemeId("agent-gamma"),
      ]).size,
    ).toBe(3);
  });
});

describe("harness identity fallback", () => {
  it.each(["example-runtime", "constructor", "toString"])(
    "uses a custom harness fallback for unknown runtime %p",
    (value) => expect(getHarnessPresentation(value)).toMatchObject({
      id: value.toLowerCase(),
      label: value.toLowerCase(),
      shortLabel: "Custom",
    }),
  );
});
