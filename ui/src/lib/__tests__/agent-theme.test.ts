import { getDeterministicAgentThemeId } from "../agent-theme";

describe("getDeterministicAgentThemeId", () => {
  it("returns the same theme for the same agent", () => {
    expect(getDeterministicAgentThemeId("agent-alpha")).toBe(
      getDeterministicAgentThemeId("agent-alpha"),
    );
  });

  it("provides varied themes for different agents", () => {
    const themes = new Set([
      getDeterministicAgentThemeId("agent-alpha"),
      getDeterministicAgentThemeId("agent-beta"),
      getDeterministicAgentThemeId("agent-gamma"),
    ]);

    expect(themes.size).toBe(3);
  });
});
