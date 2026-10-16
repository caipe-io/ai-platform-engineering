import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { StreamEvent } from "@/lib/streaming/types";
import type { WfStepRun } from "@/store/workflow-exec-store";
import { WorkflowStepTimeline } from "../WorkflowStepTimeline";

jest.mock("@/components/chat/DynamicAgentTimeline", () => ({
  AgentTimeline: ({ data }: { data: { finalAnswer: string | null } }) => (
    <div data-testid="agent-timeline">{data.finalAnswer}</div>
  ),
}));

jest.mock("@/components/chat/MetadataInputForm", () => ({
  MetadataInputForm: ({ onSubmit }: { onSubmit: (values: Record<string, string>) => void }) => <button onClick={() => onSubmit({ answer: "example" })}>Submit workflow input</button>,
}));

jest.mock("@/components/chat/ToolApprovalCard", () => ({
  ToolApprovalCard: ({ allowedDecisions, onApprove, onReject, onEdit }: { allowedDecisions: string[]; onApprove: () => void; onReject: () => void; onEdit: (args: Record<string, unknown>) => void }) => <div>
    {allowedDecisions.includes("approve") && <button onClick={onApprove}>Approve workflow tool</button>}
    {allowedDecisions.includes("reject") && <button onClick={onReject}>Reject workflow tool</button>}
    {allowedDecisions.includes("edit") && <button onClick={() => onEdit({ value: "edited" })}>Edit workflow tool</button>}
  </div>,
}));

jest.mock("@/components/dynamic-agents/AgentAvatar", () => ({
  AgentAvatar: () => <span data-testid="agent-avatar" />,
}));

jest.mock("@/components/shared/timeline", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}));

jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const baseStep: WfStepRun = {
  type: "step",
  index: 0,
  display_text: "Do the work",
  agent_id: "agent-1",
  status: "completed",
  prompt_sent: "prompt",
  response: "RAW TOOL RESULT",
  started_at: "2026-06-29T10:00:00.000Z",
  completed_at: "2026-06-29T10:00:02.000Z",
  attempts: 1,
  error: null,
  interrupt: null,
};

const contentEvent: StreamEvent = {
  id: "event-1",
  timestamp: new Date("2026-06-29T10:00:01.000Z"),
  type: "content",
  raw: {},
  namespace: [],
  content: "Clean streamed answer",
};

describe("WorkflowStepTimeline", () => {
  it("does not render stored step.response before the timeline when stream events exist", async () => {
    render(
      <WorkflowStepTimeline
        step={baseStep}
        events={[contentEvent]}
        isActive={false}
        agentInfo={{ name: "Agent One" }}
      />,
    );

    expect(screen.queryByTestId("workflow-step-response")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId("agent-timeline")).toHaveTextContent("Clean streamed answer");
    });
  });

  it("renders stored step.response as a markdown fallback when no stream events exist", () => {
    render(
      <WorkflowStepTimeline
        step={{ ...baseStep, response: "Fallback **answer**" }}
        events={[]}
        isActive={false}
        agentInfo={{ name: "Agent One" }}
      />,
    );

    expect(screen.getByTestId("workflow-step-response")).toBeInTheDocument();
    expect(screen.getByTestId("markdown-renderer")).toHaveTextContent("Fallback **answer**");
    expect(screen.queryByTestId("agent-timeline")).not.toBeInTheDocument();
  });
});


it.each([{ fields: [] }, { fields: [{ field_name: "answer", field_type: "text" }] }])("includes the current interrupt ID for workflow form submissions (%p)", ({ fields }) => {
  const onResume = jest.fn();
  render(<WorkflowStepTimeline step={{ ...baseStep, status: "waiting_for_input", interrupt: { type: "input_required", interruptId: "form-current", fields } }} events={[]} isActive onResume={onResume} />);
  fireEvent.click(screen.getByRole("button", { name: "Submit workflow input" }));
  expect(JSON.parse(onResume.mock.calls[0][0])).toEqual({ type: "form_input", interrupt_id: "form-current", values: { answer: "example" } });
});

it("preserves the harness's restricted single-tool decisions and exact input ID", () => {
  const onResume = jest.fn();
  render(<WorkflowStepTimeline step={{ ...baseStep, status: "waiting_for_input", interrupt: { type: "tool_approval", interruptId: "single-current", toolName: "read_file", allowedDecisions: ["reject"] } }} events={[]} isActive onResume={onResume} />);
  expect(screen.queryByRole("button", { name: "Approve workflow tool" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit workflow tool" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reject workflow tool" }));
  expect(JSON.parse(onResume.mock.calls[0][0])).toEqual({ type: "tool_approval", interrupt_id: "single-current", decision: "reject" });
});

it("submits edited workflow batch decisions once with the batch interrupt ID", () => {
  const onResume = jest.fn();
  render(<WorkflowStepTimeline step={{ ...baseStep, status: "waiting_for_input", interrupt: { type: "tool_approval", interruptId: "batch-current", toolApprovals: [
    { tool_name: "first_tool", tool_args: {}, tool_call_id: "first", allowed_decisions: ["edit"] },
    { tool_name: "second_tool", tool_args: {}, tool_call_id: "second", allowed_decisions: ["reject"] },
  ] } }} events={[]} isActive onResume={onResume} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit workflow tool" }));
  expect(onResume).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Reject workflow tool" }));
  expect(onResume).toHaveBeenCalledTimes(1);
  expect(JSON.parse(onResume.mock.calls[0][0])).toEqual({ type: "tool_approval", interrupt_id: "batch-current", decisions: [
    { decision: "edit", tool_name: "first_tool", edited_args: { value: "edited" } }, { decision: "reject", tool_name: "second_tool" },
  ] });
});
