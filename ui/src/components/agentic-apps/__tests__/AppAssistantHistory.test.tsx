import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { apiClient } from "@/lib/api-client";
import type { Conversation } from "@/types/a2a";
import { AppAssistantHistory } from "../AppAssistantHistory";

const mockStorageMode = jest.fn(() => "mongodb");
let mockConversations: Conversation[];
const mockActions = jest.fn((props: unknown) => { void props; return <span>Validated row actions</span>; });
jest.mock("@/lib/storage-config", () => ({ getStorageMode: () => mockStorageMode() }));
jest.mock("@/lib/api-client", () => ({ apiClient: { getConversations: jest.fn() } }));
jest.mock("@/store/chat-store", () => ({ useChatStore: { getState: () => ({ conversations: mockConversations }) } }));
jest.mock("@/native-extensions/HostConversationActions", () => ({ __esModule: true, default: (props: unknown) => mockActions(props) }));

const binding = { conversation_surface: "agentic-app", agentic_app_id: "example-app", agentic_app_agent_id: "example-agent" };
function conversation(id: string, metadata?: Record<string, unknown>): Conversation {
  return { id, title: id, participants: [{ type: "agent", id: "example-agent" }], metadata,
    createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"), messages: [], streamEvents: [] };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConversations = [
    conversation("Allowed app chat", binding),
    conversation("Unbound chat"),
    conversation("Other app chat", { ...binding, agentic_app_id: "secondary-app" }),
    conversation("Incomplete binding", { agentic_app_id: "example-app" }),
    conversation("Wrong surface", { ...binding, conversation_surface: "other" }),
    conversation("Wrong agent binding", { ...binding, agentic_app_agent_id: "other-agent" }),
    { ...conversation("Other agent chat", binding), participants: [{ type: "agent", id: "other-agent" }] },
    { ...conversation("Shared chat", binding), accessLevel: "shared" },
  ];
  jest.mocked(apiClient.getConversations).mockResolvedValue({ has_more: false, items: mockConversations.map(item => ({
    _id: item.id, title: item.title, participants: item.participants, metadata: item.metadata,
    access_level: item.accessLevel ?? "owner",
  })) } as never);
});

it.each(["localStorage", "mongodb"])("shows only explicitly bound, owned app chats in %s mode", async mode => {
  mockStorageMode.mockReturnValue(mode);
  const onSelect = jest.fn().mockResolvedValue(undefined);
  render(<AppAssistantHistory appId="example-app" agentId="example-agent" onSelect={onSelect} onArchived={jest.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Allowed app chat" }));
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith("Allowed app chat"));
  for (const item of mockConversations.slice(1)) expect(screen.queryByText(item.title)).toBeNull();
  if (mode === "localStorage") expect(apiClient.getConversations).not.toHaveBeenCalled();
  else expect(apiClient.getConversations).toHaveBeenCalledWith(expect.objectContaining({ source: "web", client_type: "webui", archived: false }));
});

it("defers each row's validation and controls until its actions are requested", async () => {
  mockStorageMode.mockReturnValue("localStorage");
  mockConversations.push(conversation("Another allowed chat", binding));
  render(<AppAssistantHistory appId="example-app" agentId="example-agent" onSelect={jest.fn()} onArchived={jest.fn()} />);
  await screen.findByRole("button", { name: "Another allowed chat" });
  expect(mockActions).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Actions for Allowed app chat" }));
  expect(await screen.findByText("Validated row actions")).toBeInTheDocument();
  expect(mockActions).toHaveBeenCalledTimes(1);
  expect(mockActions).toHaveBeenCalledWith(expect.objectContaining({ appId: "example-app", agentId: "example-agent", conversationId: "Allowed app chat" }));
});
