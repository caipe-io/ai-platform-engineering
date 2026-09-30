/** @jest-environment node */

const collections = new Map<string, unknown[]>();

jest.mock("@/lib/mongodb", () => ({
  getCollection: jest.fn(async (name: string) => ({
    findOne: async () => (collections.get(name) ?? [])[0] ?? null,
  })),
}));

import {
  GLOBAL_DEFAULT_MODEL,
  readPlatformLlm,
  resolveLlmModel,
  toModelRef,
} from "../platform-llm.server";

const PLATFORM = { id: "platform-model", provider: "aws-bedrock" };
const REGISTERED = { model_id: "registry-model", provider: "openai" };

function setPlatformLlm(value: unknown) {
  collections.set("platform_config", [{ platform_llm: value }]);
}

beforeEach(() => {
  collections.clear();
});

describe("toModelRef", () => {
  it("accepts a complete pair and trims it", () => {
    expect(toModelRef({ id: " a ", provider: " b " })).toEqual({ id: "a", provider: "b" });
  });

  it.each([
    [{ id: "a" }],
    [{ provider: "b" }],
    [{ id: "", provider: "b" }],
    [null],
    ["a"],
  ])("rejects the incomplete value %p", (value) => {
    expect(toModelRef(value)).toBeNull();
  });
});

describe("readPlatformLlm", () => {
  it("returns the configured model", async () => {
    setPlatformLlm(PLATFORM);
    await expect(readPlatformLlm()).resolves.toEqual(PLATFORM);
  });

  it("returns null when unset or half-set", async () => {
    setPlatformLlm(null);
    await expect(readPlatformLlm()).resolves.toBeNull();
    setPlatformLlm({ id: "only-id" });
    await expect(readPlatformLlm()).resolves.toBeNull();
  });
});

describe("resolveLlmModel precedence", () => {
  it("prefers a feature's own pinned model over the platform default", async () => {
    setPlatformLlm(PLATFORM);
    await expect(
      resolveLlmModel({ id: "config", provider: "openai" }),
    ).resolves.toEqual({ id: "config", provider: "openai" });
  });

  it("uses the platform default when the feature pins nothing", async () => {
    setPlatformLlm(PLATFORM);
    await expect(resolveLlmModel()).resolves.toEqual(PLATFORM);
  });

  it("falls back to the first registered model when nothing else is set", async () => {
    setPlatformLlm(null);
    collections.set("llm_models", [REGISTERED]);
    await expect(resolveLlmModel()).resolves.toEqual({
      id: "registry-model",
      provider: "openai",
    });
  });

  it("ends at the global default", async () => {
    setPlatformLlm(null);
    await expect(resolveLlmModel()).resolves.toEqual(GLOBAL_DEFAULT_MODEL);
  });

  it("ignores a half-configured pin rather than calling a broken model", async () => {
    setPlatformLlm(PLATFORM);
    await expect(resolveLlmModel({ id: "config" })).resolves.toEqual(
      PLATFORM,
    );
  });
});
