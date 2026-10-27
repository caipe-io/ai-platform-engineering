import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import HostConversationActions from "../HostConversationActions";

const mockLoad = jest.fn();
const mockArchive = jest.fn();
const mockRename = jest.fn();
const mockServerRename = jest.fn();
const mockStorageMode = jest.fn(() => "mongodb");
jest.mock("@/lib/storage-config", () => ({ getStorageMode: () => mockStorageMode() }));
jest.mock("@/lib/api-client", () => ({ apiClient: { updateConversation: (...args: unknown[]) => mockServerRename(...args) } }));
jest.mock("../host-chat", () => ({ loadHostConversation: (...args: unknown[]) => mockLoad(...args) }));
jest.mock("@/store/chat-store", () => ({ useChatStore: {
  getState: () => ({ deleteConversation: mockArchive, updateConversationTitle: mockRename }), setState: jest.fn(),
} }));
jest.mock("@/components/chat/ShareButton", () => ({ ShareButton: ({ conversationId }: { conversationId: string }) =>
  <button>Share {conversationId}</button> }));

const props = { appId: "example-app", agentId: "example-agent", conversationId: "example-chat",
  onArchived: jest.fn(), onHistoryChange: jest.fn() };
beforeEach(() => {
  jest.clearAllMocks();
  mockStorageMode.mockReturnValue("mongodb");
  mockRename.mockResolvedValue(undefined);
  mockServerRename.mockResolvedValue(undefined);
  mockLoad.mockResolvedValue({ saved: { _id: "example-chat", title: "Example", access_level: "owner" } });
  mockArchive.mockResolvedValue(undefined);
});

it("renames and archives local history through the store without server sharing or mutations", async () => {
  mockStorageMode.mockReturnValue("localStorage");
  render(<HostConversationActions {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Rename conversation" }));
  expect(screen.queryByRole("button", { name: "Share example-chat" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Conversation title" }), { target: { value: "Renamed local chat" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(props.onHistoryChange).toHaveBeenCalledTimes(1));
  expect(mockRename).toHaveBeenCalledWith("example-chat", "Renamed local chat");
  expect(mockServerRename).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Archive conversation" }));
  await waitFor(() => expect(props.onArchived).toHaveBeenCalledTimes(1));
  expect(mockArchive).toHaveBeenCalledWith("example-chat", { selectNext: false });
});

it("uses the host share control without an archive browser", async () => {
  render(<HostConversationActions {...props} />);
  await screen.findByRole("button", { name: "Share example-chat" });
  expect(mockLoad).toHaveBeenCalledWith("example-app", "example-agent", "example-chat");
  expect(screen.queryByRole("button", { name: "Open archive" })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("uses the same authorized rename dialog for the compact chat title", async () => {
  render(<HostConversationActions {...props} variant="title" conversationTitle="Current title" />);
  expect(screen.getByRole("heading", { name: "Current title" })).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "Rename conversation" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Conversation title" }), { target: { value: "Updated title" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(props.onHistoryChange).toHaveBeenCalledTimes(1));
  expect(mockServerRename).toHaveBeenCalledWith("example-chat", { title: "Updated title" });
  expect(screen.queryByRole("button", { name: /Archive conversation|Share example-chat/ })).toBeNull();
});

it("renders a shared chat title without an owner rename command", async () => {
  mockLoad.mockResolvedValue({ saved: { title: "Shared title", access_level: "shared_readonly" } });
  render(<HostConversationActions {...props} variant="title" />);
  await screen.findByRole("heading", { name: "Shared title" });
  expect(screen.queryByRole("button", { name: "Rename conversation" })).toBeNull();
});

it("archives through the host store and only then notifies the app", async () => {
  render(<HostConversationActions {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Archive conversation" }));
  await waitFor(() => expect(props.onArchived).toHaveBeenCalledTimes(1));
  expect(mockArchive).toHaveBeenCalledWith("example-chat", { selectNext: false });
});

it("keeps the selected chat when the archive request fails", async () => {
  mockArchive.mockRejectedValue(new Error("Archive was denied"));
  render(<HostConversationActions {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Archive conversation" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Archive was denied");
  expect(props.onArchived).not.toHaveBeenCalled();
});

it("does not show owner controls for a shared conversation", async () => {
  mockLoad.mockResolvedValue({ saved: { access_level: "shared" } });
  render(<HostConversationActions {...props} />);
  await waitFor(() => expect(mockLoad).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: /Share|Archive conversation/ })).toBeNull();
});

it("fails closed when app or conversation access is denied", async () => {
  mockLoad.mockRejectedValue(new Error("Access denied"));
  render(<HostConversationActions {...props} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Access denied");
  expect(screen.queryByRole("button")).toBeNull();
  expect(mockArchive).not.toHaveBeenCalled();
});

it("blocks archive while the app is changing conversations", async () => {
  render(<HostConversationActions {...props} disabled />);
  expect(await screen.findByRole("button", { name: "Archive conversation" })).toBeDisabled();
  expect(mockArchive).not.toHaveBeenCalled();
});

it("keeps a failed rename visible inside the open dialog", async () => {
  mockServerRename.mockRejectedValueOnce(new Error("Rename was denied"));
  render(<HostConversationActions {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Rename conversation" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Conversation title" }), { target: { value: "Updated title" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("Rename was denied");
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(props.onHistoryChange).not.toHaveBeenCalled();
});
