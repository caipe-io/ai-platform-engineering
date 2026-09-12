import {
  evaluateAgenticAppCasCompatibility,
  resolveAgenticAppCasMode,
} from "../cas-compat";

describe("External App CAS compatibility", () => {
  it("defaults to enforce mode", () => {
    expect(resolveAgenticAppCasMode(undefined)).toBe("enforce");
  });

  it("fails closed on a CAS denial in enforce mode", async () => {
    const authorizer = jest.fn().mockResolvedValue({
      decision: "DENY",
      reason: "NO_CAPABILITY",
      retriable: false,
    });
    const result = await evaluateAgenticAppCasCompatibility({
      appId: "example-app",
      subjectId: "test-user",
      localEffect: "allow",
      correlationId: "correlation-example",
      action: "write",
      authorizer,
    });

    expect(result.effectiveEffect).toBe("deny");
    expect(authorizer).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: { type: "agentic_app", id: "example-app" },
        action: "write",
      }),
      { correlationId: "correlation-example" },
    );
  });

  it("records a shadow denial without changing a local allow", async () => {
    const result = await evaluateAgenticAppCasCompatibility({
      appId: "example-app",
      subjectId: "test-user",
      localEffect: "allow",
      correlationId: "correlation-example",
      mode: "shadow",
      authorizer: async () => ({
        decision: "DENY",
        reason: "NO_CAPABILITY",
        retriable: false,
      }),
    });

    expect(result.casDecision).toBe("DENY");
    expect(result.effectiveEffect).toBe("allow");
  });
});
