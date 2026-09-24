/**
 * @jest-environment node
 *
 * RFC 9728 protected-resource metadata for the Platform MCP endpoint.
 */

import { NextRequest } from "next/server";

const mockIsPlatformMcpEnabled = jest.fn();

jest.mock("@/lib/mcp/guard", () => ({
  isPlatformMcpEnabled: () => mockIsPlatformMcpEnabled(),
}));

function getRequest(): NextRequest {
  return new NextRequest(
    new URL("/.well-known/oauth-protected-resource/api/mcp", "http://localhost:3000"),
  );
}

const ORIGINAL_ENV = process.env;

describe("GET /.well-known/oauth-protected-resource/api/mcp", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("404s when the Platform MCP feature is disabled", async () => {
    mockIsPlatformMcpEnabled.mockReturnValue(false);
    process.env.OIDC_ISSUER = "https://idp.example.com/realms/caipe";
    const { GET } = await import("../route");

    const response = await GET(getRequest());

    expect(response.status).toBe(404);
  });

  it("404s when no OIDC issuer is configured, rather than an empty metadata document", async () => {
    mockIsPlatformMcpEnabled.mockReturnValue(true);
    delete process.env.OIDC_ISSUER;
    const { GET } = await import("../route");

    const response = await GET(getRequest());

    expect(response.status).toBe(404);
  });

  it("advertises the resource and its authorization server when enabled", async () => {
    mockIsPlatformMcpEnabled.mockReturnValue(true);
    process.env.OIDC_ISSUER = "https://idp.example.com/realms/caipe/";
    const { GET } = await import("../route");

    const response = await GET(getRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      resource: "http://localhost:3000/api/mcp",
      authorization_servers: ["https://idp.example.com/realms/caipe"],
      bearer_methods_supported: ["header"],
    });
  });
});
