import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { apiClient } from "@/lib/api-client";
import type { Conversation } from "@/types/mongodb";
import { RecycleBinDialog } from "../RecycleBinDialog";

const mockLoadConversations = jest.fn();
jest.mock("@/lib/api-client", () => ({ apiClient: {
  getTrash: jest.fn(), restoreConversation: jest.fn(), permanentDeleteConversation: jest.fn(),
} }));
jest.mock("@/store/chat-store", () => ({
  useChatStore: () => ({ loadConversationsFromServer: mockLoadConversations }),
}));

const archived = {
  _id: "example-conversation", title: "Archived conversation", deleted_at: new Date("2026-01-01"),
} as Conversation;

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(apiClient.getTrash).mockResolvedValue({ items: [archived], total: 1 } as Awaited<ReturnType<typeof apiClient.getTrash>>);
  jest.mocked(apiClient.restoreConversation).mockResolvedValue({ ...archived, deleted_at: undefined });
  jest.mocked(apiClient.permanentDeleteConversation).mockResolvedValue({ deleted: true, permanent: true });
  mockLoadConversations.mockResolvedValue(undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

async function confirmPermanentDelete() {
  fireEvent.click(await screen.findByRole("button", { name: "Delete conversation permanently" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm", exact: true }));
}

it("shows a restore conflict accessibly and retains the archived row", async () => {
  jest.mocked(apiClient.restoreConversation).mockRejectedValueOnce(new Error("Permanent cleanup has started; this conversation can no longer be restored."));
  const onRestored = jest.fn();
  render(<RecycleBinDialog open onOpenChange={jest.fn()} onRestored={onRestored} />);
  fireEvent.click(await screen.findByRole("button", { name: "Restore conversation" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Permanent cleanup has started");
  expect(screen.getByText(archived.title)).toBeInTheDocument();
  expect(mockLoadConversations).not.toHaveBeenCalled();
  expect(onRestored).not.toHaveBeenCalled();
});

it("shows a permanent-delete failure without removing the archived row", async () => {
  jest.mocked(apiClient.permanentDeleteConversation).mockRejectedValueOnce(new Error("Deletion could not be started. Please try again."));
  render(<RecycleBinDialog open onOpenChange={jest.fn()} />);
  await confirmPermanentDelete();

  expect(await screen.findByRole("alert")).toHaveTextContent("Deletion could not be started");
  expect(screen.getByText(archived.title)).toBeInTheDocument();
});

it("reports accepted cleanup as background work and removes its claimed row", async () => {
  jest.mocked(apiClient.permanentDeleteConversation).mockResolvedValueOnce({ deleted: false, permanent: true, pending: true });
  render(<RecycleBinDialog open onOpenChange={jest.fn()} />);
  await confirmPermanentDelete();

  expect(await screen.findByRole("status")).toHaveTextContent("Deletion has started. Cleanup will continue in the background.");
  expect(screen.queryByText(archived.title)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(apiClient.permanentDeleteConversation).toHaveBeenCalledTimes(1);
});

it("clears an earlier action error when another action begins", async () => {
  jest.mocked(apiClient.restoreConversation).mockRejectedValueOnce(new Error("Restore unavailable"));
  render(<RecycleBinDialog open onOpenChange={jest.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Restore conversation" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Delete conversation permanently" }));

  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Confirm", exact: true })).toBeInTheDocument();
});

it("clears pending-cleanup feedback when the archive is reopened", async () => {
  jest.mocked(apiClient.permanentDeleteConversation).mockResolvedValueOnce({ deleted: false, permanent: true, pending: true });
  const onOpenChange = jest.fn();
  const view = render(<RecycleBinDialog open onOpenChange={onOpenChange} />);
  await confirmPermanentDelete();
  await screen.findByRole("status");
  view.rerender(<RecycleBinDialog open={false} onOpenChange={onOpenChange} />);
  view.rerender(<RecycleBinDialog open onOpenChange={onOpenChange} />);

  await screen.findByText(archived.title);
  expect(screen.queryByRole("status")).toBeNull();
});

it("disables restore and deletion for an already claimed cleanup", async () => {
  const claimed = { ...archived, purge: { token: "example-token", started_at: new Date(), lease_until: new Date(),
    retry_after: new Date(), last_attempted_at: new Date(), reason: "retention" as const } };
  jest.mocked(apiClient.getTrash).mockResolvedValueOnce({ items: [claimed], total: 1 } as Awaited<ReturnType<typeof apiClient.getTrash>>);
  render(<RecycleBinDialog open onOpenChange={jest.fn()} />);

  expect(await screen.findByRole("button", { name: "Restore conversation" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Delete conversation permanently" })).toBeDisabled();
  expect(screen.getByText("Cleanup in progress")).toBeInTheDocument();
  expect(apiClient.restoreConversation).not.toHaveBeenCalled();
});

it("retains the normal successful restore and sidebar refresh behavior", async () => {
  const onRestored = jest.fn();
  render(<RecycleBinDialog open onOpenChange={jest.fn()} onRestored={onRestored} />);
  fireEvent.click(await screen.findByRole("button", { name: "Restore conversation" }));

  await waitFor(() => expect(screen.queryByText(archived.title)).toBeNull());
  expect(mockLoadConversations).toHaveBeenCalledTimes(1);
  expect(onRestored).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
});
