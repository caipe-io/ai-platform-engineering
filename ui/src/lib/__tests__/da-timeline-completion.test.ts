import { createTimelineManager } from "../da-timeline-manager";

it("does not complete a running tool when server completion is unknown", () => {
  const manager = createTimelineManager();
  manager.pushToolStart({ tool_call_id: "example-call", tool_name: "wait", args: { seconds: 300 } }, []);
  manager.finalize("unknown");
  const data = manager.getGroupedData();
  expect(JSON.stringify(data)).toContain('"status":"running"');
  expect(data.segments.at(-1)).toMatchObject({ type: "status", status: "unknown" });
  expect(JSON.stringify(data)).not.toContain('"status":"completed"');
});
