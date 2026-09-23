import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

const mockUpdate = jest.fn();
const mockSignOut = jest.fn();
let mockSession: Record<string, unknown> | null = null;

jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: mockSession, update: mockUpdate }),
  signOut: (...args: unknown[]) => mockSignOut(...args),
}));

import { ImpersonationBanner } from "../ImpersonationBanner";

describe("ImpersonationBanner", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = null;
    mockUpdate.mockResolvedValue(undefined);
    mockSignOut.mockResolvedValue(undefined);
  });

  it("stays hidden for an ordinary session", () => {
    const { container } = render(<ImpersonationBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("identifies the target and requires a fresh login on exit", async () => {
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
    const exitButton = screen.getByRole("button", { name: "Exit & sign out" });
    expect(exitButton).toHaveClass("bg-amber-950", "text-white");
    fireEvent.click(exitButton);

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith({
        impersonation: { action: "stop" },
      });
      expect(mockSignOut).toHaveBeenCalledWith({
        callbackUrl: "/login?callbackUrl=%2Fadmin%2Fsecurity%2Fimpersonation",
      });
    });
  });

  it("signs out even when stopping impersonation in place fails", async () => {
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
    mockUpdate.mockRejectedValue(new Error("session update failed"));

    render(<ImpersonationBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Exit & sign out" }));

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledWith({
        callbackUrl: "/login?callbackUrl=%2Fadmin%2Fsecurity%2Fimpersonation",
      });
    });
  });
});
