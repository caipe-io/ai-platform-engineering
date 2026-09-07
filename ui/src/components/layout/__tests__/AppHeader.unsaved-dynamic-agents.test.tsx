/** User-facing unsaved-change behavior for application navigation links. */

import React from "react";
import { render, fireEvent } from "@testing-library/react";

// ============================================================================
// Mocks — must be hoisted above component import
// ============================================================================

let mockPathname = "/dynamic-agents";
const mockRequestNavigation = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

jest.mock("@/store/unsaved-changes-store", () => ({
  useUnsavedChangesStore: jest.fn(),
}));

import { useUnsavedChangesStore } from "@/store/unsaved-changes-store";
import { finishNavigationProgress } from "@/lib/navigation-progress";
import { GuardedNavigationLink } from "../GuardedNavigationLink";

// ============================================================================
// Tests
// ============================================================================

describe("GuardedNavigationLink", () => {
  beforeEach(() => {
    mockRequestNavigation.mockReset();
    (useUnsavedChangesStore as unknown as jest.Mock).mockReset();
    finishNavigationProgress();
  });

  afterEach(() => {
    finishNavigationProgress();
  });

  it("on /dynamic-agents with unsaved changes: click is intercepted", () => {
    mockPathname = "/dynamic-agents";
    (useUnsavedChangesStore as unknown as jest.Mock).mockReturnValue({
      hasUnsavedChanges: true,
      requestNavigation: mockRequestNavigation,
    });

    const { getByRole } = render(
      <GuardedNavigationLink href="/chat">Chat</GuardedNavigationLink>,
    );
    const link = getByRole("link", { name: "Chat" });

    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    const preventSpy = jest.spyOn(ev, "preventDefault");
    link.dispatchEvent(ev);

    expect(preventSpy).toHaveBeenCalled();
    expect(mockRequestNavigation).toHaveBeenCalledWith("/chat");
    expect(document.documentElement).not.toHaveAttribute("data-navigation-pending");
  });

  it("on /dynamic-agents with NO unsaved changes: click is NOT intercepted", () => {
    mockPathname = "/dynamic-agents";
    (useUnsavedChangesStore as unknown as jest.Mock).mockReturnValue({
      hasUnsavedChanges: false,
      requestNavigation: mockRequestNavigation,
    });

    const { getByRole } = render(
      <GuardedNavigationLink href="/chat">Chat</GuardedNavigationLink>,
    );
    fireEvent.click(getByRole("link", { name: "Chat" }));

    expect(mockRequestNavigation).not.toHaveBeenCalled();
    expect(document.documentElement).toHaveAttribute("data-navigation-pending","true");
  });

  it("on collection editing with unsaved changes: click is intercepted", () => {
    mockPathname = "/knowledge-bases/collections";
    (useUnsavedChangesStore as unknown as jest.Mock).mockReturnValue({
      hasUnsavedChanges: true,
      requestNavigation: mockRequestNavigation,
    });

    const { getByRole } = render(
      <GuardedNavigationLink href="/chat">Chat</GuardedNavigationLink>,
    );
    const link = getByRole("link", { name: "Chat" });

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    const preventSpy = jest.spyOn(event, "preventDefault");
    link.dispatchEvent(event);

    expect(preventSpy).toHaveBeenCalled();
    expect(mockRequestNavigation).toHaveBeenCalledWith("/chat");
    expect(document.documentElement).not.toHaveAttribute("data-navigation-pending");
  });

  it("on an unrelated path with unsaved changes: click is NOT intercepted", () => {
    mockPathname = "/some-other-page";
    (useUnsavedChangesStore as unknown as jest.Mock).mockReturnValue({
      hasUnsavedChanges: true,
      requestNavigation: mockRequestNavigation,
    });

    const { getByRole } = render(
      <GuardedNavigationLink href="/chat">Chat</GuardedNavigationLink>,
    );
    fireEvent.click(getByRole("link", { name: "Chat" }));

    expect(mockRequestNavigation).not.toHaveBeenCalled();
  });

  it("on /workflows with unsaved changes: click is intercepted", () => {
    mockPathname = "/workflows";
    (useUnsavedChangesStore as unknown as jest.Mock).mockReturnValue({
      hasUnsavedChanges: true,
      requestNavigation: mockRequestNavigation,
    });

    const { getByRole } = render(
      <GuardedNavigationLink href="/chat">Chat</GuardedNavigationLink>,
    );
    const link = getByRole("link", { name: "Chat" });

    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    const preventSpy = jest.spyOn(ev, "preventDefault");
    link.dispatchEvent(ev);

    expect(preventSpy).toHaveBeenCalled();
    expect(mockRequestNavigation).toHaveBeenCalledWith("/chat");
  });

  it("clicking a link to the SAME pathname is not intercepted (no-op navigation)", () => {
    mockPathname = "/dynamic-agents";
    (useUnsavedChangesStore as unknown as jest.Mock).mockReturnValue({
      hasUnsavedChanges: true,
      requestNavigation: mockRequestNavigation,
    });

    const { getByRole } = render(
      <GuardedNavigationLink href="/dynamic-agents">Self</GuardedNavigationLink>
    );
    fireEvent.click(getByRole("link", { name: "Self" }));

    expect(mockRequestNavigation).not.toHaveBeenCalled();
  });
});
