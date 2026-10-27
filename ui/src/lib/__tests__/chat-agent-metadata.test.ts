import { buildAgentChatTitle,fetchAgentInfoForChat } from "../chat-agent-metadata";

const agentcoreAgent = {
  _id: "agent-primary",
  name: "Primary Agent",
  execution_harness_id: "agentcore",
};

describe("fetchAgentInfoForChat", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  it("uses the full detail response when the viewer can read it", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: agentcoreAgent }),
    });

    await expect(fetchAgentInfoForChat("agent-primary")).resolves.toEqual({
      agent: agentcoreAgent,
      notFound: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404])("falls back to use-authorized metadata when the detail route returns %s", async (status) => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: [agentcoreAgent] }),
      });

    await expect(fetchAgentInfoForChat("agent-primary")).resolves.toEqual({
      agent: agentcoreAgent,
      notFound: false,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/dynamic-agents/available");
  });

  it("keeps a missing agent marked as deleted after the fallback misses", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: [] }),
      });

    await expect(fetchAgentInfoForChat("agent-missing")).resolves.toEqual({
      agent: null,
      notFound: true,
    });
  });
});

describe("buildAgentChatTitle", () => {
  it("keeps the selected agent visible in the browser tab", () => {
    expect(buildAgentChatTitle("Primary Agent", "CAIPE")).toBe(
      "Primary Agent · Chat · CAIPE",
    );
  });
});
