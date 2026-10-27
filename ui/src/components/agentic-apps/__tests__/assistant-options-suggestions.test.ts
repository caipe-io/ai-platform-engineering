import { validateAssistantOptions } from "../../../../app-sdk/assistant-options.mjs";

describe("shared assistant suggestions", () => {
  it("accepts an explicit opt-in with bounded prompts", () => {
    expect(() => validateAssistantOptions({
      version: "1.0",
      presentation: { showSuggestions: true, suggestedPrompts: ["Explain this example"] },
    })).not.toThrow();
    expect(() => validateAssistantOptions({
      version: "1.0",
      presentation: { showSuggestions: false, suggestedPrompts: [] },
    })).not.toThrow();
  });

  it("rejects invalid visibility and prompt declarations", () => {
    for (const presentation of [
      { showSuggestions: "true" },
      { suggestedPrompts: "Explain this example" },
      { suggestedPrompts: Array(9).fill("Example") },
      { suggestedPrompts: [" "] },
    ]) {
      expect(() => validateAssistantOptions({ version: "1.0", presentation })).toThrow();
    }
  });
});
