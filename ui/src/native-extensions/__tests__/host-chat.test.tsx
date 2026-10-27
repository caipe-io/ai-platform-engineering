import { render, screen, waitFor } from "@testing-library/react";
import { createHostChatCapability, loadHostConversation } from "../host-chat";
import type { Conversation } from "@/types/a2a";

const mockLoad = jest.fn();
const mockSelect = jest.fn();
const mockGet = jest.fn();
const mockStorageMode = jest.fn(() => "mongodb");
jest.mock("@/lib/storage-config", () => ({ getStorageMode: () => mockStorageMode() }));
const mockState = { conversations: [] as Conversation[], setActiveConversation: mockSelect,
  loadMessagesFromServer: mockLoad };
const mockPanel = jest.fn((props: unknown) => { void props; return <p>Host conversation</p>; });
jest.mock("@/components/chat/DynamicAgentChatPanel", () => ({ ChatPanel: (props: unknown) => mockPanel(props) }));
jest.mock("@/lib/api-client", () => ({ apiClient: { getConversation: (...args: unknown[]) => mockGet(...args) } }));
jest.mock("@/store/chat-store", () => ({ useChatStore: {
  getState: () => mockState,
  setState: (update: (state: typeof mockState) => object) => Object.assign(mockState, update(mockState)),
} }));

const originalFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks(); mockState.conversations = [];
  mockStorageMode.mockReturnValue("mongodb");
  global.fetch = jest.fn().mockImplementation(async (url: string) => ({ ok: true, json: async () =>
    url === "/api/dynamic-agents/available" ? { success: true, data: [{ _id: "example-agent", name: "Example Assistant",
      presentation: { app: { id: "example-app", name: "Example App" }, available: true } }] } : { item: {
      canLaunch: true, assistantAgentId: "example-agent" } } }));
  mockGet.mockResolvedValue({ _id: "example-chat", title: "Example", participants: [{ type: "agent", id: "example-agent" }],
    metadata: { agent_id: "example-agent" }, created_at: "2026-01-01", updated_at: "2026-01-01" });
  mockLoad.mockResolvedValue(undefined);
});

it("restores local history from the store, preserving dates, metadata and messages", async () => {
  mockStorageMode.mockReturnValue("localStorage");
  const local: Conversation = { id: "example-chat", title: "Local chat", participants: [{ type: "agent", id: "example-agent" }],
    createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-02"), messages: [], streamEvents: [],
    metadata: { conversation_surface: "agentic-app", agentic_app_id: "example-app", agentic_app_agent_id: "example-agent" } };
  mockState.conversations = [local];
  const { saved } = await loadHostConversation("example-app", "example-agent", "example-chat");
  expect(saved).toMatchObject({ _id: local.id, created_at: local.createdAt, updated_at: local.updatedAt,
    metadata: local.metadata, access_level: "owner" });
  const { Panel } = createHostChatCapability("example-app");
  render(<Panel conversationId="example-chat" agentId="example-agent" />);
  await screen.findByText("Host conversation");
  expect(mockSelect).toHaveBeenCalledWith("example-chat");
  expect(mockState.conversations[0]).toMatchObject({ id: local.id, metadata: local.metadata });
  expect(mockState.conversations[0].messages).toBe(local.messages);
  expect(mockGet).not.toHaveBeenCalled();
});

it("rejects missing local history without calling the MongoDB API", async () => {
  mockStorageMode.mockReturnValue("localStorage");
  await expect(loadHostConversation("example-app", "example-agent", "missing")).rejects.toThrow("local history");
  expect(mockGet).not.toHaveBeenCalled();
});

it("rejects another app's conversation even when it uses the same agent", async () => {
  mockGet.mockResolvedValue({ participants: [{ type: "agent", id: "example-agent" }], metadata: { agentic_app_id: "secondary-app" } });
  await expect(loadHostConversation("example-app", "example-agent", "other-chat")).rejects.toThrow("another app");
  expect(mockSelect).not.toHaveBeenCalled();
});
afterEach(() => { global.fetch = originalFetch; });

it("renders the host conversation and leaves its stream alive when the app closes", async () => {
  const { Panel } = createHostChatCapability("example-app");
  const options = { use_live_source: false };
  const view = render(<Panel conversationId="example-chat" agentId="example-agent" requestOptions={options} />);
  await screen.findByText("Host conversation");
  expect(mockSelect).toHaveBeenCalledWith("example-chat");
  expect(mockLoad).toHaveBeenCalledWith("example-chat", { force: true });
  expect(mockPanel.mock.calls.at(-1)?.[0]).toMatchObject({ requestOptions: options,
    agent: { _id: "example-agent", presentation: { app: { id: "example-app" } } } });
  view.unmount();
  expect(mockState.conversations).toHaveLength(1);
});

it("rejects a conversation belonging to another agent before selecting it", async () => {
  mockGet.mockResolvedValue({ _id: "example-chat", participants: [{ type: "agent", id: "other-agent" }] });
  const { Panel } = createHostChatCapability("example-app");
  render(<Panel conversationId="example-chat" agentId="example-agent" />);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Agent does not match"));
  expect(mockSelect).not.toHaveBeenCalled(); expect(mockLoad).not.toHaveBeenCalled();
});

it("does not load a conversation when app launch access is denied", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false });
  const { Panel } = createHostChatCapability("example-app");
  render(<Panel conversationId="example-chat" agentId="example-agent" />);
  await screen.findByRole("alert"); expect(mockGet).not.toHaveBeenCalled();
});

it("does not load the conversation when the agent-use catalog denies access", async () => {
  global.fetch = jest.fn().mockImplementation(async (url: string) => ({ ok: true, json: async () =>
    url === "/api/dynamic-agents/available" ? { success: true, data: [] } : { item: { canLaunch: true, assistantAgentId: "example-agent" } } }));
  const { Panel } = createHostChatCapability("example-app");
  render(<Panel conversationId="example-chat" agentId="example-agent" />);
  await screen.findByRole("alert");
  expect(mockGet).not.toHaveBeenCalled();
});
