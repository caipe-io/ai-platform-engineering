/**
 * @jest-environment node
 */

import { grantDiagnosticAgentAccess } from "@/lib/mcp-http-server-client";

const mockWriteOpenFgaTuples = jest.fn();

jest.mock("@/lib/rbac/openfga", () => ({
  writeOpenFgaTuples: (...args: unknown[]) => mockWriteOpenFgaTuples(...args),
}));

describe("mcp-http-server-client diagnostic grants", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWriteOpenFgaTuples.mockResolvedValue(undefined);
  });

  it("grants the minted local service account only the temporary scan path", async () => {
    const writes = await grantDiagnosticAgentAccess(
      "knowledge-base",
      "mcp-test-knowledge-base",
      { sub: "anonymous-local-dev" },
      { type: "service_account", id: "service-account-sub" },
    );

    expect(writes).toEqual([
      {
        user: "service_account:service-account-sub",
        relation: "caller",
        object: "mcp_gateway:list",
      },
      {
        user: "service_account:service-account-sub",
        relation: "user",
        object: "agent:mcp-test-knowledge-base",
      },
      {
        user: "agent:mcp-test-knowledge-base",
        relation: "caller",
        object: "tool:knowledge-base/*",
      },
    ]);
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({ writes, deletes: [] });
  });
});
