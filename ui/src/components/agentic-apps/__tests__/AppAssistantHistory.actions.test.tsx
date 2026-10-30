import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { apiClient } from "@/lib/api-client";
import { AppAssistantHistory } from "../AppAssistantHistory";

const mockArchive = jest.fn();
jest.mock("@/lib/storage-config", () => ({ getStorageMode: () => "mongodb" }));
jest.mock("@/lib/api-client", () => ({ apiClient: { getConversations: jest.fn(), getConversation: jest.fn(), updateConversation: jest.fn() } }));
jest.mock("@/store/chat-store", () => ({ useChatStore: { getState: () => ({ conversations: [], deleteConversation: mockArchive }), setState: jest.fn() } }));
jest.mock("@/components/chat/ShareDialog", () => ({ ShareDialog: ({ open }: { open: boolean }) => open ? <div role="dialog" aria-label="Share conversation" /> : null }));

const originalFetch = global.fetch;
const rows = Array.from({ length: 20 }, (_, index) => ({
  _id: `example-chat-${index}`, title: `Example chat ${index}`, access_level: "owner",
  participants: [{ type: "agent", id: "example-agent" }],
  metadata: { conversation_surface: "agentic-app", agentic_app_id: "example-app", agentic_app_agent_id: "example-agent" },
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(apiClient.getConversations).mockResolvedValue({ has_more: false, items: rows } as never);
  jest.mocked(apiClient.getConversation).mockImplementation(async id => rows.find(row => row._id === id) as never);
  global.fetch = jest.fn(async (url: string) => ({ ok: true, json: async () => url === "/api/dynamic-agents/available"
    ? { success: true, data: [{ _id: "example-agent" }] }
    : { item: { canLaunch: true, assistantAgentId: "example-agent" } } })) as jest.Mock;
  mockArchive.mockResolvedValue(undefined);
});
afterEach(() => { global.fetch = originalFetch; });

async function renderHistory() {
  const onArchived = jest.fn();
  const view = render(<AppAssistantHistory appId="example-app" agentId="example-agent" onSelect={jest.fn()} onArchived={onArchived} />);
  const item = (await screen.findByRole("button", { name: "Example chat 5", exact: true })).closest("li")!;
  return { item, onArchived, ...view };
}

test("20 history rows cause no action reads until a specific action is requested", async () => {
  const { item } = await renderHistory();
  expect(screen.getAllByRole("listitem")).toHaveLength(20);
  fireEvent.mouseEnter(item);
  fireEvent.focus(within(item).getByRole("button", { name: "Example chat 5", exact: true }));
  expect(global.fetch).not.toHaveBeenCalled();
  expect(apiClient.getConversation).not.toHaveBeenCalled();
  expect(apiClient.getConversations).toHaveBeenCalledTimes(1);

  fireEvent.click(within(item).getByRole("button", { name: "Rename conversation" }));
  await screen.findByRole("dialog", { name: "Rename conversation" });
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(apiClient.getConversation).toHaveBeenCalledTimes(1);
  expect(apiClient.getConversation).toHaveBeenCalledWith("example-chat-5");
  expect(screen.getByRole("textbox", { name: "Conversation title" })).toHaveValue("Example chat 5");
});

test("opens sharing from the first click after validating only the selected row", async () => {
  const { item } = await renderHistory();
  fireEvent.click(within(item).getByRole("button", { name: "Share conversation" }));
  await screen.findByRole("dialog", { name: "Share conversation" });
  expect(apiClient.getConversation).toHaveBeenCalledTimes(1);
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test.each(["Rename conversation", "Share conversation", "Archive conversation"])("blocks %s when launch access was revoked", async label => {
  const { item, onArchived } = await renderHistory();
  global.fetch = jest.fn().mockResolvedValue({ ok: false });
  fireEvent.click(within(item).getByRole("button", { name: label }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(apiClient.getConversation).not.toHaveBeenCalled();
  expect(mockArchive).not.toHaveBeenCalled();
  expect(onArchived).not.toHaveBeenCalled();
});

test("archives only the explicitly requested row after owner validation", async () => {
  const { item, onArchived } = await renderHistory();
  fireEvent.click(within(item).getByRole("button", { name: "Archive conversation" }));
  await waitFor(() => expect(onArchived).toHaveBeenCalledWith("example-chat-5"));
  expect(mockArchive).toHaveBeenCalledWith("example-chat-5", { selectNext: false });
  expect(apiClient.getConversation).toHaveBeenCalledTimes(1);
});

test("does not archive after the history row unmounts during validation", async () => {
  let finish!: (value: never) => void;
  jest.mocked(apiClient.getConversation).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { item, unmount } = await renderHistory();
  fireEvent.click(within(item).getByRole("button", { name: "Archive conversation" }));
  await waitFor(() => expect(apiClient.getConversation).toHaveBeenCalledTimes(1));
  unmount();
  await act(async () => { finish(rows[5] as never); });
  expect(mockArchive).not.toHaveBeenCalled();
});
