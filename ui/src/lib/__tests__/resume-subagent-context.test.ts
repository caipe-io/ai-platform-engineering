import { createSubagentResumeSeedEvents } from "@/lib/resume-subagent-context";
import { createStreamEvent } from "@/lib/streaming/types";

describe("createSubagentResumeSeedEvents", () => {
  it("carries only active root subagent tasks into a resume turn", () => {
    const events = [
      createStreamEvent("tool_start", {
        tool_name: "task",
        tool_call_id: "active-task",
        args: { subagent_type: "agent-test-2", description: "Collect fruit" },
        namespace: [],
      }),
      // AG-UI sends a second tool-start callback when args finish streaming.
      createStreamEvent("tool_start", {
        tool_name: "task",
        tool_call_id: "active-task",
        args: { subagent_type: "agent-test-2", description: "Collect fruit" },
        namespace: [],
      }),
      createStreamEvent("tool_start", {
        tool_name: "task",
        tool_call_id: "completed-task",
        args: { subagent_type: "agent-test-1" },
        namespace: [],
      }),
      createStreamEvent("tool_end", {
        tool_call_id: "completed-task",
        namespace: [],
      }),
      createStreamEvent("tool_start", {
        tool_name: "request_user_input",
        tool_call_id: "child-tool",
        namespace: ["active-task"],
      }),
    ];

    const seeds = createSubagentResumeSeedEvents(events);

    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({
      type: "tool_start",
      isResumeSeed: true,
      namespace: [],
      toolData: {
        tool_name: "task",
        tool_call_id: "active-task",
        args: { subagent_type: "agent-test-2", description: "Collect fruit" },
      },
    });
  });
});
