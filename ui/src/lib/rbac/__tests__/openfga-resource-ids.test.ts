/**
 * @jest-environment node
 */
import {
  openFgaResourceId,
  openFgaResourceObject,
  parseOpenFgaObject,
  parseOpenFgaResourceId,
} from "../openfga-resource-ids";

describe("openFgaResourceId / openFgaResourceObject", () => {
  it("passes an already-safe id through unchanged, for any resource type", () => {
    expect(openFgaResourceId("agent", "64f1a2b3c4d5e6f7a8b9c0d1")).toBe("64f1a2b3c4d5e6f7a8b9c0d1");
    expect(openFgaResourceId("llm_model", "gpt-4o")).toBe("gpt-4o");
  });

  it("b64-encodes an OpenFGA-unsafe llm_model id (colons are unsafe — collide with the type:id separator)", () => {
    const encoded = openFgaResourceId("llm_model", "bedrock:anthropic.claude-sonnet-5");
    expect(encoded).toMatch(/^b64_/);
    expect(openFgaResourceObject("llm_model", "bedrock:anthropic.claude-sonnet-5")).toBe(`llm_model:${encoded}`);
  });

  it("does not b64-encode an unsafe id for a non-llm_model type (only llm_model opts in)", () => {
    // Mirrors production: other resource ids (Mongo ObjectIds) are always
    // OpenFGA-safe already, so encoding is scoped to the one type that isn't.
    expect(openFgaResourceId("agent", "has:colon")).toBe("has:colon");
  });
});

describe("parseOpenFgaResourceId / parseOpenFgaObject — inverse of the encoder", () => {
  it("round-trips a b64-encoded id back to the original", () => {
    const original = "bedrock:anthropic.claude-sonnet-5";
    const encoded = openFgaResourceId("llm_model", original);
    expect(parseOpenFgaResourceId(encoded)).toBe(original);
  });

  it("leaves an unencoded id unchanged", () => {
    expect(parseOpenFgaResourceId("64f1a2b3c4d5e6f7a8b9c0d1")).toBe("64f1a2b3c4d5e6f7a8b9c0d1");
  });

  it("round-trips a full list-objects object string (type:id) for a safe id", () => {
    const object = openFgaResourceObject("agent", "64f1a2b3c4d5e6f7a8b9c0d1");
    expect(object).toBe("agent:64f1a2b3c4d5e6f7a8b9c0d1");
    expect(parseOpenFgaObject(object)).toBe("64f1a2b3c4d5e6f7a8b9c0d1");
  });

  it("round-trips a full list-objects object string for a b64-encoded id", () => {
    const original = "bedrock:anthropic.claude-sonnet-5";
    const object = openFgaResourceObject("llm_model", original);
    expect(parseOpenFgaObject(object)).toBe(original);
  });

  it("falls back to the raw input instead of throwing on malformed b64_ input", () => {
    expect(() => parseOpenFgaResourceId("b64_not-valid-base64!!!")).not.toThrow();
  });
});
