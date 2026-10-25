/** @jest-environment node */
import { invokeHarnessGatewayRun } from "../harness-gateway";

const run = {
  run_id: "run-example", agent_id: "agent-example", conversation_id: "conversation-example",
  harness_id: "agentcore", last_sequence: 3,
};

beforeEach(() => {
  jest.resetAllMocks();
  process.env.HARNESS_ENGINE_URL = "http://harness-engine:8010";
  process.env.HARNESS_ENGINE_INTERNAL_TOKEN = "test-internal-token";
});

afterEach(() => jest.restoreAllMocks());

it.each(["completed", "failed", "cancelled"])("consumes the committed event tail before returning %s", async (status) => {
  const reply = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
  const fetchMock = jest.spyOn(global, "fetch")
    .mockResolvedValueOnce(reply({ ...run, status: "queued", last_sequence: 0 }))
    // The run completed after Engine read the event prefix, before reading its metadata.
    .mockResolvedValueOnce(reply({
      run: { ...run, status }, next_cursor: 1,
      events: [{ sequence: 1, event_type: "content.delta", data: { text: "first" } }],
    }))
    .mockResolvedValueOnce(reply({
      run: { ...run, status }, next_cursor: 3,
      events: [
        { sequence: 2, event_type: "content.delta", data: { text: " second" } },
        { sequence: 3, event_type: `run.${status}`, data: { code: "example_failure", message: "Example failure" } },
      ],
    }));
  const response = await invokeHarnessGatewayRun(
    { agent_id: run.agent_id, conversation_id: run.conversation_id, message: "hello" },
    { subject: "test-user" },
  );
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls[2][0]).toContain("events?after=1&wait=");
  const body = await response.json();
  if (status === "completed") {
    expect(response.status).toBe(200);
    expect(body.content).toBe("first second");
  } else if (status === "failed") {
    expect(response.status).toBe(502);
    expect(body.error).toBe("Example failure");
    expect(body.code).toBe("example_failure");
  } else {
    expect(response.status).toBe(409);
    expect(body.code).toBe("harness_run_cancelled");
  }
});
