import { act, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import type { StoreApi, UseBoundStore } from "zustand";
import { useChatStore } from "@/store/chat-store";
import { LiveStreamBanner } from "../LiveStreamBanner";

jest.mock("@/lib/agentic-apps/use-chat-session-recovery", () => ({ useChatSessionRecovery: jest.fn() }));

interface BannerState {
  streamingConversations: Map<string, unknown>;
  externalActivity: Record<string, { state: string }>;
  conversations: Array<{ id: string; title: string; messages: string[] }>;
}

jest.mock("@/store/chat-store", () => ({
  useChatStore: jest.requireActual("zustand").create(() => ({
    streamingConversations: new Map(), externalActivity: {}, conversations: [],
  })),
}));

const store = useChatStore as unknown as UseBoundStore<StoreApi<BannerState>>;

beforeEach(() => {
  store.setState({
    streamingConversations: new Map([["primary", {}]]),
    externalActivity: {},
    conversations: [{ id: "primary", title: "Example response", messages: [] }],
  });
});

it("does not rerender the banner for message-token updates", () => {
  const onRender = jest.fn();
  render(<Profiler id="banner" onRender={onRender}><LiveStreamBanner /></Profiler>);
  onRender.mockClear();
  act(() => {
    store.setState({ conversations: [{ id: "primary", title: "Example response", messages: ["First token"] }] });
  });
  expect(onRender).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: /Example response/ })).toHaveAttribute("href", "/chat/primary");
});

it("does update the destination label when its title changes", () => {
  render(<LiveStreamBanner />);
  act(() => {
    store.setState({ conversations: [{ id: "primary", title: "Updated response", messages: [] }] });
  });
  expect(screen.getByRole("link", { name: /Updated response/ })).toHaveAttribute("href", "/chat/primary");
});
