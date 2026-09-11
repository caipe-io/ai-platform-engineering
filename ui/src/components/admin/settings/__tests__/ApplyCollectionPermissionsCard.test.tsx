/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

import { ApplyCollectionPermissionsCard } from "../ApplyCollectionPermissionsCard";

const COLLECTIONS = [
  {
    _id: "primary-collection",
    name: "Primary Collection",
    description: "Team knowledge",
    source_ids: ["source-a", "source-b"],
    maintainer_team_slugs: [],
    reader_team_slugs: [],
    global_read: false,
    created_by: "admin-sub",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    _permissions: {
      can_read: true,
      can_publish: true,
      can_manage: true,
      can_delegate: true,
    },
  },
];

const TEAMS = [
  { slug: "owner-team", name: "Owner Team" },
  { slug: "search-team", name: "Search Team" },
];

function mockFetch({
  apply = { success: true, data: { updated_count: 2, skipped_count: 0 } },
}: { apply?: object } = {}): void {
  global.fetch = jest.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if (href === "/api/rag/collections") {
      return Promise.resolve({
        json: () =>
          Promise.resolve({ success: true, data: { collections: COLLECTIONS } }),
      } as Response);
    }
    if (href === "/api/dynamic-agents/teams") {
      return Promise.resolve({
        json: () => Promise.resolve({ success: true, data: TEAMS }),
      } as Response);
    }
    if (
      href ===
        "/api/admin/rag/collections/primary-collection/apply-permissions" &&
      init?.method === "POST"
    ) {
      return Promise.resolve({
        json: () => Promise.resolve(apply),
      } as Response);
    }
    return Promise.reject(new Error(`Unexpected fetch: ${href}`));
  });
}

async function openDialogAndSelectCollection() {
  fireEvent.click(screen.getByTestId("apply-collection-permissions-button"));
  const trigger = await screen.findByRole("combobox", { name: "Collection" });
  fireEvent.click(trigger);
  fireEvent.click(
    await screen.findByRole("option", { name: /Primary Collection/i }),
  );
}

describe("ApplyCollectionPermissionsCard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch();
  });

  it("renders nothing for non-admins", () => {
    render(<ApplyCollectionPermissionsCard isAdmin={false} />);
    expect(
      screen.queryByText("Apply Permissions to a Collection"),
    ).not.toBeInTheDocument();
  });

  it("shows the apply-permissions control for admins", () => {
    render(<ApplyCollectionPermissionsCard isAdmin />);
    expect(
      screen.getByText("Apply Permissions to a Collection"),
    ).toBeInTheDocument();
  });

  it("disables Apply until a collection is selected", async () => {
    render(<ApplyCollectionPermissionsCard isAdmin />);
    fireEvent.click(screen.getByTestId("apply-collection-permissions-button"));
    await screen.findByRole("combobox", { name: "Collection" });

    expect(
      screen.getByTestId("apply-collection-permissions-submit"),
    ).toBeDisabled();
  });

  it("disables Apply when Set Owner is checked but no Owner is picked yet", async () => {
    render(<ApplyCollectionPermissionsCard isAdmin />);
    await openDialogAndSelectCollection();

    fireEvent.click(screen.getByText("Set Owner"));
    expect(
      screen.getByTestId("apply-collection-permissions-submit"),
    ).toBeDisabled();
  });

  it("applies an Owner to every datasource in the selected collection", async () => {
    const user = userEvent.setup();
    render(<ApplyCollectionPermissionsCard isAdmin />);
    await openDialogAndSelectCollection();

    fireEvent.click(screen.getByText("Set Owner"));
    await user.click(screen.getByRole("combobox", { name: "Owner" }));
    await user.click(await screen.findByRole("option", { name: /Owner Team/i }));

    expect(
      screen.getByTestId("apply-collection-permissions-submit"),
    ).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("apply-collection-permissions-submit"));

    await waitFor(() => {
      expect(
        screen.getByTestId("apply-collection-permissions-result"),
      ).toHaveTextContent("Updated 2 datasources");
    });
    const applyCall = (global.fetch as jest.Mock).mock.calls.find(
      ([href]) => String(href).includes("apply-permissions"),
    );
    expect(JSON.parse(String(applyCall?.[1]?.body))).toEqual({
      owner_team_slug: "owner-team",
      owner_subject: undefined,
    });
  });

  it("allows applying Search Access alone, without requiring an Owner", async () => {
    const user = userEvent.setup();
    render(<ApplyCollectionPermissionsCard isAdmin />);
    await openDialogAndSelectCollection();

    fireEvent.click(screen.getByText("Set Search Access"));
    expect(
      screen.getByTestId("apply-collection-permissions-submit"),
    ).not.toBeDisabled();

    await user.click(screen.getByRole("combobox", { name: "Search Access" }));
    await user.click(await screen.findByRole("option", { name: /Search Team/i }));

    fireEvent.click(screen.getByTestId("apply-collection-permissions-submit"));

    await waitFor(() => {
      const applyCall = (global.fetch as jest.Mock).mock.calls.find(
        ([href]) => String(href).includes("apply-permissions"),
      );
      expect(JSON.parse(String(applyCall?.[1]?.body))).toEqual({
        search_mode: "additive",
        search_team_slugs: ["search-team"],
        search_user_subjects: [],
      });
    });
  });

  it("switches Search Access apply mode to Replace when selected", async () => {
    const user = userEvent.setup();
    render(<ApplyCollectionPermissionsCard isAdmin />);
    await openDialogAndSelectCollection();

    fireEvent.click(screen.getByText("Set Search Access"));
    fireEvent.click(screen.getByRole("radio", { name: /Replace/i }));
    await user.click(screen.getByRole("combobox", { name: "Search Access" }));
    await user.click(await screen.findByRole("option", { name: /Search Team/i }));

    fireEvent.click(screen.getByTestId("apply-collection-permissions-submit"));

    await waitFor(() => {
      const applyCall = (global.fetch as jest.Mock).mock.calls.find(
        ([href]) => String(href).includes("apply-permissions"),
      );
      expect(JSON.parse(String(applyCall?.[1]?.body))).toEqual(
        expect.objectContaining({ search_mode: "replace" }),
      );
    });
  });

  it("resets the collection, Owner, and Search Access selections when reopened", async () => {
    const user = userEvent.setup();
    render(<ApplyCollectionPermissionsCard isAdmin />);
    await openDialogAndSelectCollection();

    fireEvent.click(screen.getByText("Set Owner"));
    await user.click(screen.getByRole("combobox", { name: "Owner" }));
    await user.click(await screen.findByRole("option", { name: /Owner Team/i }));
    expect(screen.getByText("Set Owner")).toBeInTheDocument();

    // Close without applying, then reopen - this tool writes tuples
    // directly with no approval step, so a stale Owner selection must
    // never silently carry over to the next collection it's used on.
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    fireEvent.click(screen.getByTestId("apply-collection-permissions-button"));
    await screen.findByRole("combobox", { name: "Collection" });

    expect(
      screen.getByRole("combobox", { name: "Collection" }),
    ).toHaveTextContent("Select a collection");
    expect(screen.queryByRole("combobox", { name: "Owner" })).not.toBeInTheDocument();
    expect(
      screen.getByTestId("apply-collection-permissions-submit"),
    ).toBeDisabled();
  });

  it("surfaces apply errors", async () => {
    mockFetch({ apply: { success: false, error: "boom" } });
    const user = userEvent.setup();
    render(<ApplyCollectionPermissionsCard isAdmin />);
    await openDialogAndSelectCollection();

    fireEvent.click(screen.getByText("Set Owner"));
    await user.click(screen.getByRole("combobox", { name: "Owner" }));
    await user.click(await screen.findByRole("option", { name: /Owner Team/i }));
    fireEvent.click(screen.getByTestId("apply-collection-permissions-submit"));

    expect(
      await screen.findByTestId("apply-collection-permissions-error"),
    ).toHaveTextContent("boom");
  });
});
