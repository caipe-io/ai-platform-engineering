import { providerBindingsWithLegacySecrets } from "../llm-provider-credentials";

describe("legacy provider references", () => {
  it("does not invent deployment choices and preserves explicitly saved empty bindings", () => {
    expect(providerBindingsWithLegacySecrets({}, [])).toEqual({});
    expect(providerBindingsWithLegacySecrets({ "aws-bedrock": {} }, [
      { id: "legacy", name: "llm:aws-bedrock:region", type: "custom" },
    ])).toEqual({ "aws-bedrock": {} });
  });
  it("uses a unique named secret without copying its value", () => {
    expect(
      providerBindingsWithLegacySecrets({}, [
        { id: "example", name: "llm:openai:api_key", type: "api_key" },
      ]).openai,
    ).toEqual({ api_key: "example" });
  });
  it("does not guess between duplicates or replace an explicit selection", () => {
    const secrets = [
      { id: "primary", name: "llm:openai:api_key", type: "api_key" },
      { id: "secondary", name: "llm:openai:api_key", type: "api_key" },
    ];
    expect(providerBindingsWithLegacySecrets({}, secrets).openai).toBeUndefined();
    expect(
      providerBindingsWithLegacySecrets(
        { openai: { api_key: "chosen" } },
        secrets,
      ).openai,
    ).toEqual({ api_key: "chosen" });
  });
});
