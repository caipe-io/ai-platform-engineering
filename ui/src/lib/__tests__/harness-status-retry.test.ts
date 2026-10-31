/** @jest-environment node */
import { fetchChatRunStatus } from "../harness-engine-session-client";

it("recovers status across temporary outages without sending a start command", async () => {
  jest.useFakeTimers();
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockRejectedValueOnce(new Error("temporary network failure"))
    .mockResolvedValueOnce(Response.json({ data: { run_id: "example", status: "running" } }));
  try {
    const status = fetchChatRunStatus("example", "example", new AbortController().signal);
    await jest.runAllTimersAsync();
    expect((await status).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => url === "/api/v1/chat/stream/status")).toBe(true);
  } finally { fetchMock.mockRestore(); jest.useRealTimers(); }
});

it("cancels the pending status retry when its panel unmounts", async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  try {
    const status = fetchChatRunStatus("example", "example", controller.signal);
    const cancelled = expect(status).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    controller.abort();
    await cancelled;
    await jest.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { fetchMock.mockRestore(); jest.useRealTimers(); }
});
