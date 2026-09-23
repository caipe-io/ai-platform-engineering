/**
 * @jest-environment jsdom
 */

import { act, render } from "@testing-library/react";

const mockUseSession = jest.fn();
const mockClearAllConversations = jest.fn();

jest.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

jest.mock("@/store/chat-store", () => ({
  useChatStore: {
    getState: () => ({ clearAllConversations: mockClearAllConversations }),
  },
}));

jest.mock("@/lib/storage-config", () => ({
  getStorageMode: () => "mongodb",
}));

import { SessionIdentityBoundary } from "../session-identity-boundary";

describe("SessionIdentityBoundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
  });

  it("keeps chat state when the authenticated identity is unchanged", () => {
    window.localStorage.setItem("caipe-session-identity", "sub:user-1");
    mockUseSession.mockReturnValue({
      status: "authenticated",
      data: { sub: "user-1", user: { email: "user-1@example.com" } },
    });

    render(<SessionIdentityBoundary />);

    expect(mockClearAllConversations).not.toHaveBeenCalled();
  });

  it("clears an unowned MongoDB chat pointer on the first identity-aware load", () => {
    mockUseSession.mockReturnValue({
      status: "authenticated",
      data: { sub: "user-1", user: { email: "user-1@example.com" } },
    });

    render(<SessionIdentityBoundary />);

    expect(mockClearAllConversations).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("caipe-session-identity")).toBe("sub:user-1");
  });

  it("clears chat state when the effective identity changes", () => {
    window.localStorage.setItem("caipe-session-identity", "sub:impersonated-user");
    mockUseSession.mockReturnValue({
      status: "authenticated",
      data: { sub: "admin-user", user: { email: "admin@example.com" } },
    });

    render(<SessionIdentityBoundary />);

    expect(mockClearAllConversations).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("caipe-session-identity")).toBe("sub:admin-user");
  });

  it("clears identity-owned state on logout", () => {
    window.localStorage.setItem("caipe-session-identity", "sub:user-1");
    mockUseSession.mockReturnValue({ status: "unauthenticated", data: null });

    render(<SessionIdentityBoundary />);

    expect(mockClearAllConversations).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("caipe-session-identity")).toBe("sub:user-1");
  });

  it("handles only one transition for repeated session renders", () => {
    mockUseSession.mockReturnValue({ status: "unauthenticated", data: null });
    const view = render(<SessionIdentityBoundary />);

    act(() => view.rerender(<SessionIdentityBoundary />));

    expect(mockClearAllConversations).toHaveBeenCalledTimes(1);
  });
});
