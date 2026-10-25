import { createHmac } from "crypto";
import {
  trustedInteractionFromInternalHeaders,
  trustedInteractionFromRequest,
  trustedInteractionProofHeaders,
} from "../trusted-interaction";

describe("trustedInteractionFromRequest", () => {
  beforeEach(() => {
    process.env.SLACK_LINK_HMAC_SECRET = "test-signing-secret";
    process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET = "test-internal-secret";
    jest.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);
  });

  afterEach(() => {
    delete process.env.SLACK_LINK_HMAC_SECRET;
    delete process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET;
    jest.restoreAllMocks();
  });

  function request(overrides: Record<string, string> = {}) {
    const timestamp = "1750000000";
    const payload = ["slack", "direct", timestamp, "POST", "/api/v1/chat/invoke"].join("\n");
    const signature = createHmac("sha256", "test-signing-secret").update(payload).digest("hex");
    const headers = new Headers({
        "x-caipe-interaction-source": "slack",
        "x-caipe-interaction-kind": "direct",
        "x-caipe-interaction-timestamp": timestamp,
        "x-caipe-interaction-signature": signature,
      ...overrides,
    });
    return { method: "POST", nextUrl: { pathname: "/api/v1/chat/invoke" }, headers };
  }

  it("accepts a current valid bot signature", () => {
    expect(trustedInteractionFromRequest(request())).toEqual({
      source: "slack",
      conversationKind: "direct",
      verified: true,
    });
  });

  it("fails closed for a forged signature", () => {
    expect(trustedInteractionFromRequest(request({
      "x-caipe-interaction-signature": "0".repeat(64),
    }))).toEqual({ source: "slack", conversationKind: "unknown", verified: false });
  });

  it.each([
    ["slack-bot", "slack"],
    ["webex-bot", "webex"],
  ] as const)("does not treat an unsigned %s request as web", (clientSource, source) => {
    const unsigned = request({
      "x-client-source": clientSource,
      "x-caipe-interaction-signature": "",
    });
    expect(trustedInteractionFromRequest(unsigned)).toEqual({
      source,
      conversationKind: "unknown",
      verified: false,
    });
  });

  it("continues treating a normal browser request without bot headers as web", () => {
    expect(trustedInteractionFromRequest({
      method: "POST",
      nextUrl: { pathname: "/api/v1/chat/invoke" },
      headers: new Headers(),
    })).toEqual({ source: "web", conversationKind: "personal", verified: false });
  });

  it("fails closed for a stale timestamp", () => {
    expect(trustedInteractionFromRequest(request({
      "x-caipe-interaction-timestamp": "1749999000",
    })).verified).toBe(false);
  });

  it("mints and verifies an internal proof for authenticated web use", () => {
    const proof = trustedInteractionProofHeaders({
      source: "web",
      conversationKind: "personal",
      verified: false,
    });
    expect(trustedInteractionFromInternalHeaders(new Headers(proof))).toEqual({
      source: "web",
      conversationKind: "personal",
      verified: true,
    });
  });

  it("does not mint an internal proof for a group conversation", () => {
    expect(trustedInteractionProofHeaders({
      source: "slack",
      conversationKind: "group",
      verified: true,
    })).toEqual({});
  });

  it("rejects an otherwise valid internal proof with an excessive lifetime", () => {
    const token = Buffer.from(JSON.stringify({
      source: "web",
      conversationKind: "personal",
      iat: 1_750_000_000,
      exp: 1_750_000_100,
    })).toString("base64url");
    const signature = createHmac("sha256", "test-internal-secret").update(token).digest("hex");
    expect(trustedInteractionFromInternalHeaders(new Headers({
      "X-CAIPE-Trusted-Interaction": token,
      "X-CAIPE-Trusted-Interaction-Signature": signature,
    }))).toEqual({ source: "api", conversationKind: "unknown", verified: false });
  });
});
