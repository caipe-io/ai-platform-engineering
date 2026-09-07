/**
 * @jest-environment jsdom
 */

import { renderHook, waitFor } from "@testing-library/react";

import { useAccessibleAgents } from "../useAccessibleAgents";

function agentPage(page: number, count: number, total: number) {
  const agents = Array.from({ length: count }, (_, i) => ({
    id: `agent-${page}-${i}`,
    name: `Agent ${page}-${i}`,
    description: "",
  }));
  return {
    success: true,
    data: { agents, total, page, page_size: 100 },
  };
}

describe("useAccessibleAgents", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("fetches every page when the accessible-agents list spans more than one page", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const page = Number(url.searchParams.get("page"));
      const body = page === 1 ? agentPage(1, 100, 150) : agentPage(2, 50, 150);
      return { ok: true, status: 200, json: async () => body } as Response;
    });
    global.fetch = fetchMock;

    const { result } = renderHook(() => useAccessibleAgents());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agents).toHaveLength(150);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/user/accessible-agents?page=1&page_size=100",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/user/accessible-agents?page=2&page_size=100",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("stops after a single page when total fits within one page", async () => {
    const fetchMock = jest.fn(async () => {
      return { ok: true, status: 200, json: async () => agentPage(1, 2, 2) } as Response;
    });
    global.fetch = fetchMock;

    const { result } = renderHook(() => useAccessibleAgents());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.agents).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces an error and clears agents when a page request fails", async () => {
    const fetchMock = jest.fn(async () => {
      return {
        ok: false,
        status: 500,
        json: async () => ({ success: false, error: "boom" }),
      } as Response;
    });
    global.fetch = fetchMock;

    const { result } = renderHook(() => useAccessibleAgents());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("boom");
    expect(result.current.agents).toHaveLength(0);
  });
});
