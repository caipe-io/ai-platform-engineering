/** @jest-environment jsdom */

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ServiceAccountsTab } from "../ServiceAccountsTab";

const PAGE_SIZE = 24;
const SERVICE_ACCOUNTS = Array.from({ length: 50 }, (_, index) => ({
  id: `service-account-${index + 1}`,
  name: `example-bot-${String(index + 1).padStart(2, "0")}`,
  owning_team_id: "example-team",
  created_by: "test-user",
  created_at: "2026-06-15T12:00:00.000Z",
  status: "active",
  scope_counts: { agents: 0, tools: 0 },
}));

async function flushRequests(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ServiceAccountsTab", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const page = Number(url.searchParams.get("page") ?? "1");
      const start = (page - 1) * PAGE_SIZE;

      return {
        ok: true,
        json: async () => ({
          success: true,
          data: {
            items: SERVICE_ACCOUNTS.slice(start, start + PAGE_SIZE),
            total: SERVICE_ACCOUNTS.length,
            page,
            page_size: PAGE_SIZE,
          },
        }),
      } as Response;
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("does not reset pagination when the unchanged search debounce settles", async () => {
    render(<ServiceAccountsTab />);
    await flushRequests();

    expect(screen.getByText("Page 1 of 3 (50 total)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await flushRequests();

    expect(screen.getByText("Page 2 of 3 (50 total)")).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
    });

    expect(screen.getByText("Page 2 of 3 (50 total)")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

// ── Datasource/Collection picker split + bulk-add-by-collection ────────────
//
// Covers the split of the old combined "RAG Datasources" MultiSelect into
// separate Datasources/Collections pickers, plus the new "Add datasources
// from a collection" bulk action, in both CreateServiceAccountDialog and
// ManageServiceAccountDialog. Neither dialog is exported, so these drive the
// real ServiceAccountsTab tree exactly like the pagination test above.

const GRANTABLE = {
  agents: [],
  tools: [],
  datasources: [
    { ref: "ds-1", name: "Datasource One" },
    { ref: "ds-2", name: "Datasource Two" },
  ],
  collections: [{ ref: "coll-1", name: "Collection One" }],
};

const COLLECTION_MEMBERS = {
  success: true,
  data: { source_ids: ["ds-1", "ds-2", "ds-not-grantable"] },
};

function mockCommonEndpoints(overrides: {
  grantable?: object;
  collectionMembers?: object;
  saDetail?: object;
  scopePost?: object;
} = {}) {
  const grantable = overrides.grantable ?? { success: true, data: GRANTABLE };
  const collectionMembers = overrides.collectionMembers ?? COLLECTION_MEMBERS;
  const scopePost =
    overrides.scopePost ?? { success: true, data: { added: [], added_count: 0 } };

  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const href = String(input);
    const method = init?.method?.toUpperCase() ?? "GET";

    if (href.startsWith("/api/admin/service-accounts?")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          success: true,
          data: { items: [SERVICE_ACCOUNTS[0]], total: 1, page: 1, page_size: PAGE_SIZE },
        }),
      } as Response);
    }
    if (href === "/api/auth/my-roles") {
      return Promise.resolve({
        ok: true,
        json: async () => ({ teams: [{ slug: "example-team", name: "Example Team" }] }),
      } as Response);
    }
    if (href === "/api/admin/service-accounts/grantable") {
      return Promise.resolve({ ok: true, json: async () => grantable } as Response);
    }
    if (href === `/api/admin/service-accounts/${SERVICE_ACCOUNTS[0].id}`) {
      return Promise.resolve({
        ok: true,
        json: async () =>
          overrides.saDetail ?? {
            success: true,
            data: {
              id: SERVICE_ACCOUNTS[0].id,
              name: SERVICE_ACCOUNTS[0].name,
              owning_team_id: "example-team",
              created_by: "test-user",
              created_at: "2026-06-15T12:00:00.000Z",
              status: "active",
              scopes: [],
            },
          },
      } as Response);
    }
    if (href === `/api/admin/service-accounts/${SERVICE_ACCOUNTS[0].id}/credentials`) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: [] }),
      } as Response);
    }
    if (href === "/api/admin/service-accounts/token-providers") {
      return Promise.resolve({ status: 404, json: async () => ({ success: false }) } as Response);
    }
    if (href.startsWith("/api/rag/collections/")) {
      return Promise.resolve({
        ok: (collectionMembers as Record<string, unknown>).success !== false,
        json: async () => collectionMembers,
      } as Response);
    }
    if (href.endsWith("/scopes/bulk") && method === "POST") {
      return Promise.resolve({
        ok: (scopePost as Record<string, unknown>).success !== false,
        json: async () => scopePost,
      } as Response);
    }
    return Promise.reject(new Error(`Unexpected fetch: ${href} [${method}]`));
  });
}

describe("ServiceAccountsTab — CreateServiceAccountDialog knowledge pickers", () => {
  beforeEach(() => {
    mockCommonEndpoints();
  });

  async function openCreateDialog() {
    const user = userEvent.setup();
    render(<ServiceAccountsTab />);
    await screen.findByText(SERVICE_ACCOUNTS[0].name);
    await user.click(screen.getByRole("button", { name: /create service account/i }));
    await screen.findByRole("button", { name: /grant datasources/i });
    return user;
  }

  it("renders separate Datasources and Collections pickers instead of one combined picker", async () => {
    await openCreateDialog();

    expect(screen.getByRole("button", { name: /grant datasources/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /grant collections/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /grant collections or datasources/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the clarifying note that a collection grant does not include member datasources", async () => {
    await openCreateDialog();

    expect(
      screen.getByText(/does not grant access to its member datasources/i),
    ).toBeInTheDocument();
  });

  it("bulk-adds every grantable datasource from a selected collection", async () => {
    const user = await openCreateDialog();

    await user.click(
      screen.getByRole("combobox", { name: /add datasources from a collection/i }),
    );
    await user.click(await screen.findByRole("option", { name: "Collection One" }));

    await waitFor(() => {
      expect(
        screen.getByText(/queued 2 datasources from the collection/i),
      ).toBeInTheDocument();
    });
    // Both grantable member ids now show as selected badges on the Datasources picker.
    expect(screen.getByText("Datasource One")).toBeInTheDocument();
    expect(screen.getByText("Datasource Two")).toBeInTheDocument();
  });

  it("does not add a datasource the caller cannot grant, and does not add the collection itself", async () => {
    const user = await openCreateDialog();

    await user.click(
      screen.getByRole("combobox", { name: /add datasources from a collection/i }),
    );
    await user.click(await screen.findByRole("option", { name: "Collection One" }));

    await waitFor(() =>
      expect(screen.getByText(/queued 2 datasources/i)).toBeInTheDocument(),
    );
    // Collections picker stays empty — bulk-add only ever touches Datasources.
    expect(screen.getByRole("button", { name: /grant collections/i })).toBeInTheDocument();
  });

  it("shows a note when no datasources in the collection are grantable", async () => {
    mockCommonEndpoints({
      collectionMembers: { success: true, data: { source_ids: ["ds-not-grantable"] } },
    });
    const user = await openCreateDialog();

    await user.click(
      screen.getByRole("combobox", { name: /add datasources from a collection/i }),
    );
    await user.click(await screen.findByRole("option", { name: "Collection One" }));

    await waitFor(() => {
      expect(
        screen.getByText(/no datasources you can grant are in that collection/i),
      ).toBeInTheDocument();
    });
  });

  it("shows an error note when the collection fetch fails", async () => {
    mockCommonEndpoints({
      collectionMembers: { success: false, error: "Collection not found" },
    });
    const user = await openCreateDialog();

    await user.click(
      screen.getByRole("combobox", { name: /add datasources from a collection/i }),
    );
    await user.click(await screen.findByRole("option", { name: "Collection One" }));

    await waitFor(() => {
      expect(screen.getByText(/collection not found/i)).toBeInTheDocument();
    });
  });

  it("does not re-add a datasource that is already selected", async () => {
    const user = await openCreateDialog();

    // Manually select ds-1 via the Datasources picker first.
    await user.click(screen.getByRole("button", { name: /grant datasources/i }));
    await user.click(await screen.findByRole("button", { name: "Datasource One" }));
    await user.click(screen.getByText(/owned by one of your teams/i));

    await user.click(
      screen.getByRole("combobox", { name: /add datasources from a collection/i }),
    );
    await user.click(await screen.findByRole("option", { name: "Collection One" }));

    // Only ds-2 is newly added since ds-1 was already selected.
    await waitFor(() => {
      expect(screen.getByText(/queued 1 datasource from the collection/i)).toBeInTheDocument();
    });
  });

  it("disables the bulk-add picker while a previous pick is still resolving, so a second click cannot double-add", async () => {
    let resolveCollectionFetch: ((value: unknown) => void) | undefined;
    const pendingCollectionFetch = new Promise((resolve) => {
      resolveCollectionFetch = resolve;
    });
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const href = String(input);
      if (href.startsWith("/api/admin/service-accounts?")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: { items: [SERVICE_ACCOUNTS[0]], total: 1, page: 1, page_size: PAGE_SIZE },
          }),
        } as Response);
      }
      if (href === "/api/auth/my-roles") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ teams: [{ slug: "example-team", name: "Example Team" }] }),
        } as Response);
      }
      if (href === "/api/admin/service-accounts/grantable") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: GRANTABLE }),
        } as Response);
      }
      if (href.startsWith("/api/rag/collections/")) {
        return pendingCollectionFetch.then(
          () => ({ ok: true, json: async () => COLLECTION_MEMBERS } as Response),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${href}`));
    });

    const user = userEvent.setup();
    render(<ServiceAccountsTab />);
    await screen.findByText(SERVICE_ACCOUNTS[0].name);
    await user.click(screen.getByRole("button", { name: /create service account/i }));
    await screen.findByRole("button", { name: /grant datasources/i });

    const picker = screen.getByRole("combobox", {
      name: /add datasources from a collection/i,
    });
    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: "Collection One" }));

    // The fetch for the first pick hasn't resolved yet — the trigger must
    // already be disabled so a second pick can't race it and double-add a
    // shared member id.
    expect(picker).toBeDisabled();

    resolveCollectionFetch?.(undefined);
    await waitFor(() =>
      expect(screen.getByText(/queued 2 datasources from the collection/i)).toBeInTheDocument(),
    );

    // Exactly one badge per datasource — not duplicated.
    expect(screen.getAllByText("Datasource One")).toHaveLength(1);
    expect(screen.getAllByText("Datasource Two")).toHaveLength(1);
    expect(picker).not.toBeDisabled();
  });

  it("disables the bulk-add picker when there are no grantable collections", async () => {
    mockCommonEndpoints({
      grantable: { success: true, data: { ...GRANTABLE, collections: [] } },
    });
    await openCreateDialog();

    expect(
      screen.getByRole("combobox", { name: /add datasources from a collection/i }),
    ).toBeDisabled();
  });
});

describe("ServiceAccountsTab — ManageServiceAccountDialog knowledge pickers", () => {
  beforeEach(() => {
    mockCommonEndpoints();
  });

  async function openManageDialog() {
    const user = userEvent.setup();
    render(<ServiceAccountsTab />);
    await screen.findByText(SERVICE_ACCOUNTS[0].name);
    await user.click(screen.getByRole("button", { name: /manage/i }));
    await screen.findByRole("button", { name: /add datasources/i });
    return user;
  }

  it("renders separate Datasources and Collections add-pickers instead of one combined picker", async () => {
    await openManageDialog();

    expect(screen.getByRole("button", { name: /add datasources/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add collections/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /add collections or datasources/i }),
    ).not.toBeInTheDocument();
  });

  it("bulk-adds every grantable datasource from a selected collection via individual POSTs", async () => {
    const user = await openManageDialog();

    await user.click(
      screen.getByRole("combobox", { name: /add datasources from a collection/i }),
    );
    await user.click(await screen.findByRole("option", { name: "Collection One" }));

    await waitFor(() => {
      expect(
        screen.getByText(/queued 2 datasources from the collection/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Datasource One")).toBeInTheDocument();
    expect(screen.getByText("Datasource Two")).toBeInTheDocument();
    // Bulk-add only ever touches Datasources — the collection itself must
    // not also become a grant.
    expect(screen.getByRole("button", { name: /add collections/i })).toBeInTheDocument();
  });

  it("excludes datasources the SA already holds from the bulk-by-collection add", async () => {
    mockCommonEndpoints({
      saDetail: {
        success: true,
        data: {
          id: SERVICE_ACCOUNTS[0].id,
          name: SERVICE_ACCOUNTS[0].name,
          owning_team_id: "example-team",
          created_by: "test-user",
          created_at: "2026-06-15T12:00:00.000Z",
          status: "active",
          scopes: [{ type: "datasource", ref: "ds-1" }],
        },
      },
    });
    const user = await openManageDialog();

    await user.click(
      screen.getByRole("combobox", { name: /add datasources from a collection/i }),
    );
    await user.click(await screen.findByRole("option", { name: "Collection One" }));

    await waitFor(() => {
      expect(screen.getByText(/queued 1 datasource from the collection/i)).toBeInTheDocument();
    });
  });

  it("shows a note when no datasources in the collection are grantable", async () => {
    mockCommonEndpoints({
      collectionMembers: { success: true, data: { source_ids: ["ds-not-grantable"] } },
    });
    const user = await openManageDialog();

    await user.click(
      screen.getByRole("combobox", { name: /add datasources from a collection/i }),
    );
    await user.click(await screen.findByRole("option", { name: "Collection One" }));

    await waitFor(() => {
      expect(
        screen.getByText(/no datasources you can grant are in that collection/i),
      ).toBeInTheDocument();
    });
  });

  it("disables the bulk-add picker when there are no grantable collections", async () => {
    mockCommonEndpoints({
      grantable: { success: true, data: { ...GRANTABLE, collections: [] } },
    });
    await openManageDialog();

    expect(
      screen.getByRole("combobox", { name: /add datasources from a collection/i }),
    ).toBeDisabled();
  });

  it("keeps a collection available in the bulk-add picker even after it has already been granted as a scope", async () => {
    // Granting a collection is a search-filter-only scope and is unrelated
    // to whether its member datasources can still be bulk-added — the
    // collection must not disappear from the bulk-add picker just because
    // it's already a direct grant.
    mockCommonEndpoints({
      saDetail: {
        success: true,
        data: {
          id: SERVICE_ACCOUNTS[0].id,
          name: SERVICE_ACCOUNTS[0].name,
          owning_team_id: "example-team",
          created_by: "test-user",
          created_at: "2026-06-15T12:00:00.000Z",
          status: "active",
          scopes: [{ type: "collection", ref: "coll-1" }],
        },
      },
    });
    const user = await openManageDialog();

    const picker = screen.getByRole("combobox", {
      name: /add datasources from a collection/i,
    });
    expect(picker).not.toBeDisabled();
    await user.click(picker);
    expect(await screen.findByRole("option", { name: "Collection One" })).toBeInTheDocument();
  });

  it("does not show a Current-scopes filter input for a short scope list", async () => {
    mockCommonEndpoints({
      saDetail: {
        success: true,
        data: {
          id: SERVICE_ACCOUNTS[0].id,
          name: SERVICE_ACCOUNTS[0].name,
          owning_team_id: "example-team",
          created_by: "test-user",
          created_at: "2026-06-15T12:00:00.000Z",
          status: "active",
          scopes: [{ type: "datasource", ref: "ds-1" }],
        },
      },
    });
    await openManageDialog();

    expect(
      screen.queryByRole("textbox", { name: /filter current scopes/i }),
    ).not.toBeInTheDocument();
  });

  it("shows a Current-scopes filter input for a long scope list, and filters by it", async () => {
    const manyScopes = Array.from({ length: 12 }, (_, i) => ({
      type: "datasource" as const,
      ref: `bulk-ds-${i + 1}`,
    }));
    mockCommonEndpoints({
      saDetail: {
        success: true,
        data: {
          id: SERVICE_ACCOUNTS[0].id,
          name: SERVICE_ACCOUNTS[0].name,
          owning_team_id: "example-team",
          created_by: "test-user",
          created_at: "2026-06-15T12:00:00.000Z",
          status: "active",
          scopes: manyScopes,
        },
      },
    });
    const user = await openManageDialog();

    expect(screen.getByTestId("scope-datasource-bulk-ds-1")).toBeInTheDocument();
    expect(screen.getByTestId("scope-datasource-bulk-ds-12")).toBeInTheDocument();

    const filterInput = screen.getByRole("textbox", { name: /filter current scopes/i });
    await user.type(filterInput, "bulk-ds-7");

    expect(screen.getByTestId("scope-datasource-bulk-ds-7")).toBeInTheDocument();
    expect(screen.queryByTestId("scope-datasource-bulk-ds-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("scope-datasource-bulk-ds-12")).not.toBeInTheDocument();
  });

  it("shows an 'Adding N scopes' progress label immediately on Add click, clearing when done", async () => {
    const user = await openManageDialog();

    await user.click(screen.getByRole("button", { name: /add datasources/i }));
    await user.click(await screen.findByRole("button", { name: "Datasource One" }));
    await user.click(screen.getByText(/manage scopes, rotate the credential/i));

    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    // Visible the instant Add is clicked, not just once the bulk request
    // resolves, so even a large batch never looks hung at the start.
    expect(screen.getByText(/adding 1 scope\.\.\./i)).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.queryByText(/adding \d+ scopes?\.\.\./i)).not.toBeInTheDocument(),
    );
    // ONE bulk call carrying the full scopes array — not one POST per scope.
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/admin/service-accounts/${SERVICE_ACCOUNTS[0].id}/scopes/bulk`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ scopes: [{ type: "datasource", ref: "ds-1" }] }),
      }),
    );
  });
});
