import { fireEvent, render, screen } from "@testing-library/react";

import { ConversationViewers } from "../ConversationViewers";

const mockPresence = jest.fn();
jest.mock("@/hooks/use-conversation-presence", () => ({ useConversationPresence: (id?: string) => mockPresence(id) }));
jest.mock("@/lib/storage-config", () => ({ getStorageMode: () => "mongodb" }));

it("shows unique viewers separately from browser sessions and lists their names", () => {
  mockPresence.mockReturnValue({ viewers: [
    { id: "primary", name: "Primary User", sessions: 2 },
    { id: "secondary", name: "Secondary User", sessions: 1 },
  ], sessionCount: 3 });
  render(<ConversationViewers conversationId="chat-example" />);
  fireEvent.click(screen.getByRole("button", { name: "Viewing this chat: 2 viewers · 3 sessions" }));
  expect(screen.getByText("Primary User")).toBeVisible();
  expect(screen.getByText("2 sessions")).toBeVisible();
  expect(screen.getByText("Secondary User")).toBeVisible();
  expect(screen.getByText("1 session")).toBeVisible();
  expect(mockPresence).toHaveBeenCalledWith("chat-example");
});

it("hides unavailable presence rather than displaying stale viewers", () => {
  mockPresence.mockReturnValue(null);
  const { container } = render(<ConversationViewers conversationId="chat-example" />);
  expect(container).toBeEmptyDOMElement();
});
