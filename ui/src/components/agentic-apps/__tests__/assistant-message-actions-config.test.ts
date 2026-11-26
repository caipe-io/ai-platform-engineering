import { validateAssistantConfiguration } from "../../../../app-sdk/assistant-options.mjs";

const options = {
  version: "1.0" as const,
  messageActions: [
    { id: "flag-answer", label: "Flag answer", icon: "flag" as const, path: "/api/example/actions/flag" },
    { id: "mark", label: "Mark", icon: "check" as const, path: "/api/example/actions/mark" },
  ],
};

describe("message action visibility configuration", () => {
  it("accepts declared ids with explicit visibility", () => {
    expect(() => validateAssistantConfiguration({
      version: "1.0", visible: true, messageActions: { "flag-answer": { visible: true }, mark: { visible: false } },
    }, options)).not.toThrow();
  });

  it("treats a missing entry as hidden by accepting a partial map", () => {
    expect(() => validateAssistantConfiguration({ version: "1.0", visible: true, messageActions: {} }, options)).not.toThrow();
    expect(() => validateAssistantConfiguration({ version: "1.0", visible: true }, options)).not.toThrow();
  });

  it.each([
    ["a malformed id", { "Bad Id": { visible: true } }],
    ["a non-boolean flag", { mark: { visible: "yes" } }],
    ["extra state fields", { mark: { visible: true, grant: true } }],
    ["a non-object value", { mark: true }],
  ])("rejects %s", (_name, messageActions) => {
    expect(() => validateAssistantConfiguration({ version: "1.0", visible: true, messageActions }, options)).toThrow();
  });

  it("accepts an undeclared id so the declared ones still apply; the host ignores it", () => {
    expect(() => validateAssistantConfiguration({
      version: "1.0", visible: true, messageActions: { mark: { visible: true }, other: { visible: true } },
    }, options)).not.toThrow();
    expect(() => validateAssistantConfiguration({
      version: "1.0", visible: true, messageActions: { mark: { visible: true } },
    }, { version: "1.0" })).not.toThrow();
  });
});
