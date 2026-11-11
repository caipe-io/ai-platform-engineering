import { fireEvent, render, screen } from "@testing-library/react";

import { RunningChats } from "../RunningChats";
import { useUnsavedChangesStore } from "@/store/unsaved-changes-store";
import type { Conversation } from "@/types/a2a";
import type { ExternalChatActivity } from "@/store/chat-store";

let mockPathname = "/projects";
const mockRecovery = jest.fn();
const mockState = {
  streamingConversations: new Map<string, unknown>(),
  externalActivity: {} as Record<string, ExternalChatActivity>,
  conversations: [] as Conversation[],
};

jest.mock("next/navigation", () => ({ usePathname: () => mockPathname }));
jest.mock("next/link", () => {
  const MockLink = ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>;
  return { __esModule: true, default: MockLink };
});
jest.mock("@/lib/navigation-progress", () => ({
  beginNavigationProgress: jest.fn(),
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

it("keeps the live indicator visible for the currently open chat", () => {
  addChat("example-primary", "Primary chat");
  mockPathname = "/chat/example-primary";
  render(<RunningChats />);
  const trigger = screen.getByRole("button", { name: "Live Agent Chat (1). Choose a chat" });
  expect(trigger).toHaveTextContent(/^Live Agent Chat \(1\)$/);
  expect(trigger.querySelector(".motion-safe\\:animate-pulse")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Open Primary chat" })).not.toBeInTheDocument();
  fireEvent.click(trigger);
  const link = screen.getByRole("link", { name: "Open Primary chat" });
  expect(link).toHaveAttribute("href", "/chat/example-primary");
  expect(link).toHaveAttribute("aria-current", "page");
  expect(link).toHaveTextContent("Primary chat");
});

it("lists every live chat with a link to its specific conversation", () => {
  addChat("example-primary", "Primary chat");
  addChat("example-secondary", "Secondary chat");
  render(<RunningChats />);
  fireEvent.click(screen.getByRole("button", { name: "Live Agent Chat (2). Choose a chat" }));
  expect(screen.getByRole("link", { name: "Open Primary chat" })).toHaveAttribute("href", "/chat/example-primary");
  const secondary = screen.getByRole("link", { name: "Open Secondary chat" });
  expect(secondary).toHaveAttribute("href", "/chat/example-secondary");
  // Prevent jsdom document navigation; closing still runs through the real link.
  secondary.addEventListener("click", event => event.preventDefault());
  fireEvent.click(secondary);
  expect(screen.queryByRole("region", { name: "Live Agent Chat" })).not.toBeInTheDocument();
});

it("counts the current chat and deduplicates app and browser observations", () => {
  addChat("example-current", "Current chat");
  addChat("example-other", "Other chat");
  mockPathname = "/chat/example-current";
  mockState.externalActivity = {
    "example-other": { agentId: "example-agent", state: "running" },
    "example-checking": { agentId: "example-agent", state: "checking" },
    "example-saving": { agentId: "example-agent", state: "saving" },
  };
  render(<RunningChats />);
  fireEvent.click(screen.getByRole("button", { name: "Live Agent Chat (3). Choose a chat" }));
  expect(screen.getByRole("link", { name: "Open Current chat" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByText("Streaming · Current chat")).toBeVisible();
  expect(screen.getAllByRole("link", { name: "Open Other chat" })).toHaveLength(1);
  expect(screen.getByRole("link", { name: "Open Untitled chat" })).toHaveTextContent("Saving response…");
});

it("preserves the existing unsaved-editor navigation guard", () => {
  addChat("example-primary", "Primary chat");
  mockPathname = "/dynamic-agents";
  useUnsavedChangesStore.setState({ hasUnsavedChanges: true });
  render(<RunningChats />);
  fireEvent.click(screen.getByRole("button", { name: "Live Agent Chat (1). Choose a chat" }));
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  fireEvent(screen.getByRole("link", { name: "Open Primary chat" }), event);
  expect(event.defaultPrevented).toBe(true);
  expect(useUnsavedChangesStore.getState().pendingNavigationHref).toBe("/chat/example-primary");
});

it("preserves the unsaved-editor guard when choosing among several chats", () => {
  addChat("example-primary", "Primary chat");
  addChat("example-secondary", "Secondary chat");
  mockPathname = "/dynamic-agents";
  useUnsavedChangesStore.setState({ hasUnsavedChanges: true });
  render(<RunningChats />);
  fireEvent.click(screen.getByRole("button", { name: "Live Agent Chat (2). Choose a chat" }));
  fireEvent.click(screen.getByRole("link", { name: "Open Secondary chat" }));
  expect(useUnsavedChangesStore.getState().pendingNavigationHref).toBe("/chat/example-secondary");
  expect(screen.queryByRole("region", { name: "Live Agent Chat" })).not.toBeInTheDocument();
});

it("updates an open picker as streams finish and resets it when none remain", () => {
  addChat("example-primary", "Primary chat");
  addChat("example-secondary", "Secondary chat");
  const { rerender, container } = render(<RunningChats />);
  fireEvent.click(screen.getByRole("button", { name: "Live Agent Chat (2). Choose a chat" }));
  mockState.streamingConversations.delete("example-primary");
  rerender(<RunningChats />);
  expect(screen.getByRole("button", { name: "Live Agent Chat (1). Choose a chat" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByRole("link", { name: "Open Primary chat" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open Secondary chat" })).toHaveAttribute("href", "/chat/example-secondary");
  addChat("example-tertiary", "Third chat");
  rerender(<RunningChats />);
  expect(screen.getByRole("button", { name: "Live Agent Chat (2). Choose a chat" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("link", { name: "Open Third chat" })).toBeVisible();
  mockState.streamingConversations.clear();
  rerender(<RunningChats />);
  expect(container).toBeEmptyDOMElement();
  addChat("example-next", "Next chat");
  rerender(<RunningChats />);
  expect(screen.getByRole("button", { name: "Live Agent Chat (1). Choose a chat" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("region", { name: "Live Agent Chat" })).not.toBeInTheDocument();
});

it("encodes conversation IDs and keeps long titles available without widening the control", () => {
  const title = "Example investigation ".repeat(12).trim();
  addChat("example/id?query", title);
  render(<RunningChats />);
  const trigger = screen.getByRole("button", { name: "Live Agent Chat (1). Choose a chat" });
  expect(trigger).toHaveTextContent(/^Live Agent Chat \(1\)$/);
  expect(trigger).not.toHaveTextContent(title);
  fireEvent.click(trigger);
  const link = screen.getByRole("link", { name: `Open ${title}` });
  expect(link).toHaveAttribute("href", "/chat/example%2Fid%3Fquery");
  expect(link).toHaveAttribute("title", title);
  expect(screen.getByText(title)).toHaveClass("whitespace-normal", "break-words");
  expect(link.querySelector(".truncate")).not.toBeInTheDocument();
});

it("does not show a live chat for an unconfirmed status check", () => {
  mockState.externalActivity = { "example-checking": { agentId: "example-agent", state: "checking" } };
  const { container } = render(<RunningChats />);
  expect(container).toBeEmptyDOMElement();
});
