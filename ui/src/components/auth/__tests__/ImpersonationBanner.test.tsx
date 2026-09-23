import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

const mockUpdate = jest.fn();
const mockReplace = jest.fn();
const mockRefresh = jest.fn();
const mockClearAllConversations = jest.fn();
let mockSession: Record<string, unknown> | null = null;

jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: mockSession, update: mockUpdate }),
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, refresh: mockRefresh }),
}));

jest.mock("@/store/chat-store", () => ({
  useChatStore: { getState: () => ({ clearAllConversations: mockClearAllConversations }) },
}));

import { ImpersonationBanner } from "../ImpersonationBanner";

describe("ImpersonationBanner", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = null;
    mockUpdate.mockResolvedValue(undefined);
  });

  it("stays hidden for an ordinary session", () => {
    const { container } = render(<ImpersonationBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("identifies the target and restores the actor session on exit", async () => {
    mockSession = {
      impersonation: {
        actor: { sub: "actor-sub", email: "admin@example.com" },
        target: {
          sub: "target-sub",
          name: "Target User",
          email: "target@example.com",
          username: "target-user",
        },
        startedAt: "2026-09-22T12:00:00.000Z",
      },
    };

    render(<ImpersonationBanner />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "You are logged in as Target User (target@example.com).",
    );
    const exitButton = screen.getByRole("button", { name: "Exit impersonation" });
    expect(exitButton).toHaveClass("bg-amber-950", "text-white");
    fireEvent.click(exitButton);

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith({
        impersonation: { action: "stop" },
      });
      expect(mockClearAllConversations).toHaveBeenCalled();
      expect(mockReplace).toHaveBeenCalledWith("/admin/security/impersonation");
      expect(mockRefresh).toHaveBeenCalled();
    });
  });
});
