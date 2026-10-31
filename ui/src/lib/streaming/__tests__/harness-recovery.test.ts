/** @jest-environment node */
import { recoverableStream } from "../clients/recoverable-stream";

it("reattaches from the last received cursor without resubmitting a command", async () => {
  const initial = new Response('id: 1\nevent: RUN_STARTED\ndata: {"runId":"run-example"}\n\nid: 2\nevent: TEXT_MESSAGE_CONTENT\ndata: {"delta":"first"}\n\n', {
    headers: { "X-Harness-Run-ID": "run-example" },
  });
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(new Response('id: 3\nevent: RUN_FINISHED\ndata: {"outcome":"success"}\n\n'));
  try {
    const received = [];
    for await (const event of recoverableStream(initial, "agui", new AbortController().signal)) received.push(event);
    expect(received.map(event => event.id)).toEqual(["1", "2", "3"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/harness-engine/runs/run-example/events/stream?after=2&protocol=agui", expect.not.objectContaining({ method: "POST" }));
  } finally { fetchMock.mockRestore(); }
});

it("keeps legacy EOF behavior when there is no admitted Engine run", async () => {
  const fetchMock = jest.spyOn(global, "fetch");
  try {
    for await (const event of recoverableStream(new Response('event: content\ndata: {"text":"example"}\n\n'), "custom", new AbortController().signal)) expect(event.event).toBe("content");
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { fetchMock.mockRestore(); }
});
