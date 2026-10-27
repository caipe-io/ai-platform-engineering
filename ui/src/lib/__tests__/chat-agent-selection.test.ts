/** @jest-environment node */

import { resolveUsableChatAgent, updateWebDefaultAgentId } from "../chat-agent-selection";

function response(data: unknown): Response {
  return Response.json({ success: true, data });
}

describe("chat agent selection", () => {
  const originalFetch = global.fetch;

  afterEach(() => { global.fetch = originalFetch; });

  it("falls through a stale personal default to an available enabled agent", async () => {
    global.fetch = jest.fn(async (url) => String(url).includes("preferences")
      ? response({ web_default_agent_id: "stale", platform_default_agent_id: "disabled" })
      : response([
        { _id: "disabled", name: "Disabled", enabled: false },
        { _id: "primary", name: "Primary", enabled: true },
      ]));
    await expect(resolveUsableChatAgent({ requireAvailableAgent: true })).resolves.toEqual({
      id: "primary", name: "Primary", source: "first-available",
    });
  });

  it("requires available-agent evidence for strict defaults", async () => {
    global.fetch = jest.fn(async (url) => String(url).includes("preferences")
      ? response({ platform_default_agent_id: "primary" })
      : new Response(null, { status: 503 }));
    await expect(resolveUsableChatAgent({ requireAvailableAgent: true }))
      .rejects.toThrow("No dynamic agents are available");
    await expect(resolveUsableChatAgent()).resolves.toEqual({
      id: "primary", name: "Default agent", source: "platform-default",
    });
  });

  it("selects an exact authorized binding without loading unrelated preferences", async () => {
    global.fetch = jest.fn(async () => response([{ _id: "primary", name: "Primary", enabled: true }]));
    await expect(resolveUsableChatAgent({ requestedAgentId: " primary " })).resolves.toEqual({
      id: "primary", name: "Primary", source: "configured",
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("/api/dynamic-agents/available", expect.any(Object));
  });

  it("never substitutes another agent for a missing configured binding", async () => {
    global.fetch = jest.fn(async () => response([{ _id: "secondary", name: "Secondary", enabled: true }]));
    await expect(resolveUsableChatAgent({ requestedAgentId: "primary" }))
      .rejects.toThrow('Configured agent "primary" is unavailable or not authorized');
  });

  it("preserves a configured lookup failure instead of claiming authorization denial", async () => {
    const error = new TypeError("Network unavailable");
    global.fetch = jest.fn().mockRejectedValue(error);
    await expect(resolveUsableChatAgent({ requestedAgentId: "primary" })).rejects.toBe(error);
  });

  it("does not start requests for an already cancelled lookup", async () => {
    global.fetch = jest.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(resolveUsableChatAgent({ signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not turn cancellation into the legacy platform-default fallback", async () => {
    const controller = new AbortController();
    global.fetch = jest.fn(async (url, init) => {
      expect(init?.signal).toBe(controller.signal);
      if (String(url).includes("preferences")) return response({ platform_default_agent_id: "primary" });
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(resolveUsableChatAgent({ signal: controller.signal })).rejects.toBe(controller.signal.reason);
  });

  it("ignores fulfilled data when cancellation occurs during the lookup", async () => {
    const controller = new AbortController();
    global.fetch = jest.fn(async () => {
      controller.abort();
      return response([{ _id: "primary", name: "Primary", enabled: true }]);
    });
    await expect(resolveUsableChatAgent({ requestedAgentId: "primary", signal: controller.signal }))
      .rejects.toBe(controller.signal.reason);
  });

  it("retains the existing personal-default update API", async () => {
    global.fetch = jest.fn(async () => response({}));
    await updateWebDefaultAgentId(" primary ");
    expect(global.fetch).toHaveBeenCalledWith("/api/user/preferences", expect.objectContaining({
      method: "PUT", body: JSON.stringify({ web_default_agent_id: "primary" }),
    }));
  });
});
