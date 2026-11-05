import { fireEvent, render, screen } from "@testing-library/react";

import { RunningChats } from "../RunningChats";
import { useUnsavedChangesStore } from "@/store/unsaved-changes-store";
import type { Conversation } from "@/types/a2a";
import type { ExternalChatActivity } from "@/store/chat-store";

let mockPathname = "/projects";
const mockPush = jest.fn();
const mockRecovery = jest.fn();
const mockState = {
  streamingConversations: new Map<string, unknown>(),
  externalActivity: {} as Record<string, ExternalChatActivity>,
  conversations: [] as Conversation[],
};

jest.mock("next/navigation", () => ({ usePathname: () => mockPathname, useRouter: () => ({ push: mockPush }) }));
jest.mock("@/lib/navigation-progress", () => ({
  pushWithNavigationProgress: (router: { push: (href: string) => void }, href: string) => router.push(href),
}));
jest.mock("@/lib/agentic-apps/use-chat-session-recovery", () => ({ useChatSessionRecovery: () => mockRecovery() }));
jest.mock("@/store/chat-store", () => ({ useChatStore: (selector: (state: typeof mockState) => unknown) => selector(mockState) }));

beforeEach(() => {
  jest.clearAllMocks();
  mockPathname = "/projects";
  mockState.streamingConversations = new Map();
  mockState.externalActivity = {};
  mockState.conversations = [];
  useUnsavedChangesStore.setState({ hasUnsavedChanges: false, pendingNavigationHref: null });
});

function addChat(id: string, title: string) {
  mockState.streamingConversations.set(id, {});
  mockState.conversations.push({ id, title } as Conversation);
}

it("keeps recovery mounted without showing a banner or an idle control", () => {
  const { container } = render(<RunningChats />);
  expect(container).toBeEmptyDOMElement();
  expect(mockRecovery).toHaveBeenCalled();
});

it("uses the visible chat's existing progress instead of a global indicator", () => {
  addChat("example-primary", "Primary chat");
  mockPathname = "/chat/example-primary";
  const { container } = render(<RunningChats />);
  expect(container).toBeEmptyDOMElement();
});

it("lists every background chat and opens the selected conversation", () => {
  addChat("example-primary", "Primary chat");
  addChat("example-secondary", "Secondary chat");
  render(<RunningChats />);
  fireEvent.click(screen.getByRole("button", { name: "2 background chats. View running chats" }));
  expect(screen.getByRole("button", { name: "Open Primary chat" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open Secondary chat" }));
  expect(mockPush).toHaveBeenCalledWith("/chat/example-secondary");
  expect(screen.queryByRole("region", { name: "Background chats" })).not.toBeInTheDocument();
});

it("counts background chats only and deduplicates app and browser observations", () => {
  addChat("example-current", "Current chat");
  addChat("example-other", "Other chat");
  mockPathname = "/chat/example-current";
  mockState.externalActivity = {
    "example-other": { agentId: "example-agent", state: "running" },
    "example-checking": { agentId: "example-agent", state: "checking" },
    "example-saving": { agentId: "example-agent", state: "saving" },
  };
  render(<RunningChats />);
  fireEvent.click(screen.getByRole("button", { name: "2 background chats. View running chats" }));
  expect(screen.queryByRole("button", { name: "Open Current chat" })).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Open Other chat" })).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Open Running chat" })).toHaveTextContent("Saving response…");
});

it("preserves the existing unsaved-editor navigation guard", () => {
  addChat("example-primary", "Primary chat");
  mockPathname = "/dynamic-agents";
  useUnsavedChangesStore.setState({ hasUnsavedChanges: true });
  render(<RunningChats />);
  fireEvent.click(screen.getByRole("button", { name: "1 background chat. View running chats" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Primary chat" }));
  expect(mockPush).not.toHaveBeenCalled();
  expect(useUnsavedChangesStore.getState().pendingNavigationHref).toBe("/chat/example-primary");
});
