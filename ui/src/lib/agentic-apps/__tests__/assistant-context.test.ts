/** @jest-environment node */

import { validateAssistantContextMessage } from "../assistant-context";

function message(context: Record<string, unknown> = { route: "/" }) {
  return {
    type: "caipe.agenticApp.context.v1",
    version: "1.0",
    appId: "example-app",
    context,
  };
}

describe("agentic app assistant context", () => {
  it("accepts bounded context for the expected app and origin", () => {
    const result = validateAssistantContextMessage({
      message: message({ route: "/reports", title: "Report" }),
      appId: "example-app",
      origin: "https://grid.example.com",
      expectedOrigin: "https://grid.example.com",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        record: expect.objectContaining({
          appId: "example-app",
          route: "/reports",
          title: "Report",
        }),
      }),
    );
  });

  it("preserves accepted resource references without rewriting identifiers", () => {
    const resourceRefs = [{ ["k".repeat(80)]: "v".repeat(2048) }];
    const result = validateAssistantContextMessage({
      message: message({ route: "/", resourceRefs }), appId: "example-app",
    });
    expect(result.ok && result.record.resourceRefs).toEqual(resourceRefs);
  });

  it.each([
    [{ ["k".repeat(81)]: "example" }],
    [{ id: "v".repeat(2049) }],
    [Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`field${i}`, "example"]))],
    Array.from({ length: 21 }, () => ({ id: "example" })),
  ])("rejects resource references exceeding field limits", (...resourceRefs) => {
    expect(validateAssistantContextMessage({
      message: message({ route: "/", resourceRefs }), appId: "example-app",
    })).toEqual({ ok: false, reasonCode: "invalid_resource_refs" });
  });

  it("rejects cross-origin, cross-app, oversized, and secret-like context", () => {
    expect(
      validateAssistantContextMessage({
        message: message(),
        appId: "example-app",
        origin: "https://other.example.com",
        expectedOrigin: "https://grid.example.com",
      }),
    ).toEqual({ ok: false, reasonCode: "invalid_origin" });

    expect(
      validateAssistantContextMessage({
        message: { ...message(), appId: "other-app" },
        appId: "example-app",
      }),
    ).toEqual({ ok: false, reasonCode: "app_mismatch" });

    expect(
      validateAssistantContextMessage({
        message: message({ route: "/", summary: "too large" }),
        appId: "example-app",
        maxBytes: 8,
      }),
    ).toEqual({ ok: false, reasonCode: "payload_too_large" });

    expect(
      validateAssistantContextMessage({
        message: message({ route: "/", apiKey: "example" }),
        appId: "example-app",
      }),
    ).toEqual({ ok: false, reasonCode: "secret_like_context" });
  });
});
