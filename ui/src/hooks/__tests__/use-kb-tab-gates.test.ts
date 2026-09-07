import { renderHook, waitFor } from "@testing-library/react";
import { useSession } from "next-auth/react";
import { isDevAnonymousAuthEnabled } from "@/lib/auth/dev-auth-provider";
import { useKbTabGates } from "../use-kb-tab-gates";

jest.mock("next-auth/react", () => ({
  useSession: jest.fn(),
}));

jest.mock("@/lib/auth/dev-auth-provider", () => ({
  isDevAnonymousAuthEnabled: jest.fn(),
}));

describe("useKbTabGates", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    (useSession as jest.Mock).mockReturnValue({ data: null, status: "unauthenticated" });
    (isDevAnonymousAuthEnabled as jest.Mock).mockReturnValue(false);
  });

  it("opens KB gates for local no-SSO dev auth", async () => {
    (isDevAnonymousAuthEnabled as jest.Mock).mockReturnValue(true);

    const { result } = renderHook(() => useKbTabGates());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orgAdminBypass).toBe(true);
    expect(result.current.gates).toEqual({
      search: true,
      data_sources: true,
      collections: true,
      graph: true,
      mcp_tools: true,
      has_any_kb: true,
      kb_count: -1,
      can_ingest: true,
      can_search: true,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fails closed when unauthenticated without dev auth", async () => {
    const { result } = renderHook(() => useKbTabGates());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orgAdminBypass).toBe(false);
    expect(result.current.gates.has_any_kb).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
