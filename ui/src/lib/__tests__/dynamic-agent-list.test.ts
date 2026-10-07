import { loadAllDynamicAgents } from "@/lib/dynamic-agent-list";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("loadAllDynamicAgents", () => {
  it("loads and deduplicates every enabled-agent page", async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: {
          items: [
            { _id: "agent-primary", name: "Primary Agent" },
            { _id: "agent-shared", name: "Shared Agent" },
          ],
          has_more: true,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: {
          items: [
            { _id: "agent-shared", name: "Updated Shared Agent" },
            { _id: "agent-secondary", name: "Secondary Agent" },
          ],
          has_more: false,
        },
      }));

    await expect(loadAllDynamicAgents({
      enabledOnly: true,
      pageSize: 2,
      fetcher: fetcher as unknown as typeof fetch,
    })).resolves.toEqual([
      { _id: "agent-primary", name: "Primary Agent" },
      { _id: "agent-shared", name: "Updated Shared Agent" },
      { _id: "agent-secondary", name: "Secondary Agent" },
    ]);

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/dynamic-agents?enabled_only=true&page=1&page_size=2",
      { cache: "no-store" },
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/api/dynamic-agents?enabled_only=true&page=2&page_size=2",
      { cache: "no-store" },
    );
  });

  it("surfaces the API error from a failed page", async () => {
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse({ error: "Agent catalog unavailable" }, 503),
    );

    await expect(loadAllDynamicAgents({
      fetcher: fetcher as unknown as typeof fetch,
    })).rejects.toThrow("Agent catalog unavailable");
  });
});
