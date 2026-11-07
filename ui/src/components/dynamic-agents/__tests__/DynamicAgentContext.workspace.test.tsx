import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DynamicAgentContext } from "../DynamicAgentContext";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import type { Conversation } from "@/types/a2a";
import { createStreamEvent } from "@/lib/streaming/types";

const mockConversation: Conversation = { id: "example-chat", title: "Example", participants: [], createdAt: new Date(), updatedAt: new Date(), messages: [], streamEvents: [createStreamEvent("tool_start", { tool_name: "write_todos", tool_call_id: "todo", namespace: [], args: { todos: [{ content: "Check the result", status: "pending" }] } })] };
jest.mock("@/store/chat-store", () => ({ useChatStore: (selector: (s: unknown) => unknown) => selector({ clearStreamEvents: jest.fn(), conversations: [mockConversation], contextUsageByConversation: {}, streamingConversations: new Map(), externalActivity: {} }) }));
jest.mock("@/store/feature-flag-store", () => ({ useFeatureFlagStore: (selector: (s: unknown) => unknown) => selector({ flags: {} }) }));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { email: "viewer@example.com" } } }) }));
jest.mock("@/components/dynamic-agents/AgentAvatar", () => ({ AgentAvatar: () => null }));
jest.mock("@/components/chat/AgentHarnessBadge", () => ({ AgentHarnessBadge: () => <span>Runtime</span> }));
jest.mock("@/components/chat/ContextUsageIndicator", () => ({ ContextUsageDetails: () => null }));
jest.mock("../FileTree", () => ({ FileTree: ({ files }: { files: string[] }) => <div>{files.join(",")}</div> }));

const agent = { _id: "example-agent", name: "Example agent", model: { id: "example-model" }, subagents: [{ agent_id: "helper", name: "Helper", description: "Checks work" }] } as DynamicAgentConfig;

beforeEach(() => { global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ files: ["report.md"] }) }); });

it("shows actual configured agents and saved tasks, with no pretend coordination toggle", () => {
  render(<DynamicAgentContext conversationId="example-chat" agentId="example-agent" agent={agent} readOnly />);
  expect(screen.getByRole("tab", { name: "Agent info" })).toHaveAttribute("aria-selected", "true");
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Agent coordination" }), { button: 0, ctrlKey: false });
  const agents = within(screen.getByRole("region", { name: "Agents" }));
  expect(agents.getByText("Example agent")).toBeInTheDocument();
  expect(agents.getByText("Helper")).toBeInTheDocument();
  expect(screen.getByText("Check the result")).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Chat mode" })).not.toBeInTheDocument();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Agent info" }), { button: 0, ctrlKey: false });
  expect(screen.queryByRole("button", { name: "Refresh Agent Session" })).not.toBeInTheDocument();
});

it("loads files on demand, distinguishes errors from empty results, and retries", async () => {
  (fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 403 });
  const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
  render(<DynamicAgentContext conversationId="example-chat" agentId="example-agent" agent={agent} />);
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Agent coordination" }), { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByRole("button", { name: "Workspace files" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
  fireEvent.click(screen.getByRole("button", { name: "Refresh files" }));
  expect(await screen.findByText("report.md")).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining(encodeURIComponent('["example-agent","example-chat","filesystem"]')), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  warning.mockRestore();
});

it("opens a requested workspace section from the collapsed rail", async () => {
  const onCollapse = jest.fn();
  const { rerender } = render(<DynamicAgentContext conversationId="example-chat" agentId="example-agent" agent={agent} collapsed onCollapse={onCollapse} />);
  fireEvent.click(screen.getByRole("button", { name: "Open workspace files" }));
  expect(onCollapse).toHaveBeenCalledWith(false);
  expect(fetch).not.toHaveBeenCalled();
  rerender(<DynamicAgentContext conversationId="example-chat" agentId="example-agent" agent={agent} collapsed={false} onCollapse={onCollapse} />);
  await waitFor(() => expect(screen.getByText("report.md")).toBeInTheDocument());
});

it("does not mark an unfinished delegation complete just because no browser is streaming", () => {
  const previous = mockConversation.streamEvents;
  mockConversation.streamEvents = [createStreamEvent("tool_start", { tool_name: "task", tool_call_id: "child-run", namespace: [], args: { subagent_type: "Example helper", description: "Review the change" } })];
  render(<DynamicAgentContext conversationId="example-chat" agentId="example-agent" agent={agent} />);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Agent coordination" }), { button: 0, ctrlKey: false });
  expect(screen.getByText("Completion unconfirmed")).toBeInTheDocument();
  mockConversation.streamEvents = previous;
});
