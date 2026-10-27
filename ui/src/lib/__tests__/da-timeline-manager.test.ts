import { createTimelineManager } from "@/lib/da-timeline-manager";
import type { SubagentSegment } from "@/types/dynamic-agent-timeline";

function getSubagent(manager: ReturnType<typeof createTimelineManager>): SubagentSegment {
  const segment = manager.getGroupedData().segments.find((item) => item.type === "subagent");
  expect(segment?.type).toBe("subagent");
  return segment as SubagentSegment;
}

describe("TimelineManager resumed subagents", () => {
  it("renders buffered subagent content immediately while streaming", () => {
    const manager = createTimelineManager();
    manager.pushToolStart(
      {
        tool_name: "task",
        tool_call_id: "task-1",
        args: { subagent_type: "agent-test-2", description: "Collect fruit" },
      },
      [],
    );

    manager.pushContent("The child is still working", ["task-1"]);

    const subagent = getSubagent(manager);
    expect(subagent.info).toMatchObject({
      id: "task-1",
      agentId: "agent-test-2",
      status: "running",
    });
    expect(subagent.segments).toContainEqual(
      expect.objectContaining({ type: "content", text: "The child is still working" }),
    );
  });

  it("creates a placeholder instead of dropping resume-only namespaced content", () => {
    const manager = createTimelineManager();

    manager.pushContent("Resumed child output", ["task-from-checkpoint"]);

    expect(getSubagent(manager)).toMatchObject({
      info: { id: "task-from-checkpoint", name: "subagent", status: "running" },
      segments: [expect.objectContaining({ type: "content", text: "Resumed child output" })],
    });

    manager.pushToolEnd("task-from-checkpoint", []);

    expect(getSubagent(manager).info.status).toBe("completed");
  });
});

it("updates remote tool output while keeping the tool running", () => {
  const manager = createTimelineManager();
  manager.pushToolStart({ tool_name: "remote", tool_call_id: "call-stream" }, []);
  manager.pushToolOutput("call-stream", [], "first");
  const first = manager.getGroupedData().segments.find(segment => segment.type === "tool");
  expect(first?.type === "tool" && first.data.status).toBe("running");
  expect(first?.type === "tool" && first.data.result).toBe("first");
  manager.pushToolOutput("call-stream", [], "first second");
  manager.pushToolEnd("call-stream", [], undefined, "first second");
  const final = manager.getGroupedData().segments.find(segment => segment.type === "tool");
  expect(final?.type === "tool" && final.data.status).toBe("completed");
  expect(final?.type === "tool" && final.data.result).toBe("first second");
});

it("isolates streamed output in a child namespace", () => {
  const manager = createTimelineManager();
  manager.pushToolStart({ tool_name: "task", tool_call_id: "child", args: { subagent_type: "example" } }, []);
  manager.pushToolStart({ tool_name: "remote", tool_call_id: "call-child" }, ["child"]);
  manager.pushToolStart({ tool_name: "remote", tool_call_id: "call-parent" }, []);
  manager.pushToolOutput("call-child", ["child"], "child output");
  const childTool = getSubagent(manager).segments.find(segment => segment.type === "tool");
  expect(childTool?.type === "tool" && childTool.data.result).toBe("child output");
  expect(childTool?.type === "tool" && childTool.data.status).toBe("running");
  const parent = manager.getGroupedData().segments.find(segment => segment.type === "tool");
  expect(parent?.type === "tool" && parent.data.result).toBeUndefined();
});
