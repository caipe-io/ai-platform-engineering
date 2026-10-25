import { evaluatePrivateResourceContext } from "../private-resource-policy";

const baseRequest = {
  subject: { type: "user" as const, id: "test-user" },
  resource: { type: "agent" as const, id: "agent-example" },
  action: "use" as const,
};

describe("private resource context policy", () => {
  it.each([
    ["slack", "group"],
    ["webex", "group"],
    ["api", "unknown"],
  ] as const)("denies private use from %s/%s", (source, conversationKind) => {
    expect(evaluatePrivateResourceContext({
      ...baseRequest,
      trustedContext: { interaction: { source, conversationKind, verified: true } },
    }, "private")).toMatchObject({
      decision: "DENY",
      reason: "PRIVATE_RESOURCE_CONTEXT_DENIED",
    });
  });

  it("allows owner checks to continue for the authenticated web UI", () => {
    expect(evaluatePrivateResourceContext({
      ...baseRequest,
      trustedContext: {
        interaction: { source: "web", conversationKind: "personal", verified: false },
      },
    }, "private")).toBeNull();
  });

  it.each(["slack", "webex"] as const)("allows owner checks to continue for verified %s DMs", (source) => {
    expect(evaluatePrivateResourceContext({
      ...baseRequest,
      trustedContext: {
        interaction: { source, conversationKind: "direct", verified: true },
      },
    }, "private")).toBeNull();
  });

  it("denies service accounts even in a verified DM", () => {
    expect(evaluatePrivateResourceContext({
      ...baseRequest,
      subject: { type: "service_account", id: "example-bot" },
      trustedContext: {
        interaction: { source: "slack", conversationKind: "direct", verified: true },
      },
    }, "private")?.decision).toBe("DENY");
  });

  it("does not narrow management actions or non-private resources", () => {
    expect(evaluatePrivateResourceContext({ ...baseRequest, action: "manage" }, "private")).toBeNull();
    expect(evaluatePrivateResourceContext(baseRequest, "team")).toBeNull();
  });
});
