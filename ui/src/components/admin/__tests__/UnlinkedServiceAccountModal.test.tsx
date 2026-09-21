/**
 * @jest-environment jsdom
 *
 * B2 — UnlinkedServiceAccountModal
 *
 * The add-scope UI mirrors ManageServiceAccountDialog (ServiceAccountsTab.tsx):
 * four separate Agents/Tools/Datasources/Collections MultiSelects, staged and
 * applied together via one "Add" click, plus an "Add datasources from a
 * collection" bulk picker that also only stages (never applies immediately).
 *
 * Tests:
 *  1. Renders scopes returned by the resolver endpoint for an admin.
 *  2. Renders read-only notice and hides edit controls for non-admins.
 *  3. Shows the "Add scopes" section for admins.
 *  4. Sends correct POST to /api/admin/service-accounts/[id]/scopes on add,
 *     for every scope type (agent/tool/datasource/collection).
 *  5. Shows a single error banner on failed add, and stops a multi-scope
 *     Add on the first failure.
 *  6. Shows remove-confirm flow before DELETE.
 *  7. Error from resolver is displayed (404/error case).
 *  8. Close button calls onOpenChange(false).
 *  9. Current-scopes filter input appears only for long lists, and filters.
 *  10. "Add datasources from a collection" stages (never immediately POSTs),
 *      excludes non-grantable/already-granted/already-queued datasources,
 *      is busy-gated, and is disabled with zero grantable collections.
 */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnlinkedServiceAccountModal } from "../UnlinkedServiceAccountModal";

// ── shared fixtures ──

// QUAL-10: sa_sub removed from BFF response — only id/name/scopes
const ANON_SA = {
  id: "anon-sub-abc",
  name: "unlinked",
  scopes: [
    { type: "agent", ref: "hello-world" },
    { type: "tool", ref: "jira/search" },
  ],
};

const GRANTABLE = {
  agents: [
    { ref: "hello-world", name: "Hello World Agent" },
    { ref: "sre-agent", name: "SRE Agent" },
  ],
  tools: [{ ref: "jira/search", name: "Jira: search" }],
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

function mockFetch({
  sa = { success: true, data: ANON_SA },
  grantable = { success: true, data: GRANTABLE },
  scopePost = { success: true, data: { added: { type: "agent", ref: "sre-agent" } } },
  scopeDelete = { success: true, data: { removed: { type: "agent", ref: "hello-world" } } },
  collectionMembers = COLLECTION_MEMBERS,
}: {
  sa?: object;
  grantable?: object;
  scopePost?: object;
  scopeDelete?: object;
  collectionMembers?: object;
} = {}) {
  global.fetch = jest.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method?.toUpperCase() ?? "GET";

    if (href.includes("/api/admin/service-accounts/unlinked")) {
      return Promise.resolve({
        ok: (sa as Record<string, unknown>).success !== false,
        json: () => Promise.resolve(sa),
      } as Response);
    }
    if (href.includes("/api/admin/service-accounts/grantable")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(grantable),
      } as Response);
    }
    if (href.includes("/api/rag/collections/") && method === "GET") {
      return Promise.resolve({
        ok: (collectionMembers as Record<string, unknown>).success !== false,
        json: () => Promise.resolve(collectionMembers),
      } as Response);
    }
    if (href.includes("/scopes") && method === "POST") {
      return Promise.resolve({
        ok: (scopePost as Record<string, unknown>).success !== false,
        json: () => Promise.resolve(scopePost),
      } as Response);
    }
    if (href.includes("/scopes") && method === "DELETE") {
      return Promise.resolve({
        ok: (scopeDelete as Record<string, unknown>).success !== false,
        json: () => Promise.resolve(scopeDelete),
      } as Response);
    }
    return Promise.reject(new Error(`Unexpected fetch: ${href} [${method}]`));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch();
});

describe("UnlinkedServiceAccountModal", () => {
  it("renders scopes returned by the resolver for an admin", async () => {
    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("scope-agent-hello-world")).toBeInTheDocument();
    });
    expect(screen.getByTestId("scope-tool-jira/search")).toBeInTheDocument();
  });

  it("renders a global (everyone) agent as a locked chip with no remove button", async () => {
    mockFetch({
      sa: {
        success: true,
        data: {
          ...ANON_SA,
          scopes: [
            { type: "agent", ref: "default", source: "everyone" },
            { type: "agent", ref: "hello-world", source: "explicit" },
          ],
        },
      },
    });

    render(<UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("scope-agent-default")).toBeInTheDocument();
    });

    // The everyone-sourced agent must NOT expose a remove control...
    expect(
      screen.queryByRole("button", { name: /remove agent default/i }),
    ).not.toBeInTheDocument();
    // ...but the explicit one still does.
    expect(
      screen.getByRole("button", { name: /remove agent hello-world/i }),
    ).toBeInTheDocument();
    // And it carries a visible "Everyone" affordance.
    expect(screen.getByTestId("scope-source-everyone-default")).toBeInTheDocument();
  });

  it("keeps long scope refs from overflowing the list item (min-w-0/shrink-0/truncate)", async () => {
    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    const code = await screen.findByTestId("scope-agent-hello-world");
    expect(code).toHaveClass("truncate");

    const item = code.closest("li");
    expect(item).toHaveClass("min-w-0");

    const label = code.closest("span");
    expect(label).toHaveClass("min-w-0");

    const icon = label?.querySelector("svg");
    expect(icon).toHaveClass("shrink-0");
  });

  it("shows the Add scopes section for admins", async () => {
    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/add scopes/i)).toBeInTheDocument();
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/admin/service-accounts/grantable?context=unlinked",
    );
    // Same four pickers as ManageServiceAccountDialog, not a single
    // type-select + one ref picker.
    expect(screen.getByRole("button", { name: /add agents/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add tools/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add datasources/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add collections/i })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /scope type/i })).not.toBeInTheDocument();
  });

  it("hides Add scopes and shows read-only notice for non-admins", async () => {
    render(
      <UnlinkedServiceAccountModal open isAdmin={false} onOpenChange={jest.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("scope-agent-hello-world")).toBeInTheDocument();
    });
    expect(screen.queryByText(/add scopes/i)).not.toBeInTheDocument();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });

  it("explains when the SA has no access", async () => {
    mockFetch({
      sa: { success: true, data: { ...ANON_SA, scopes: [] } },
    });

    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/no access has been granted/i),
      ).toBeInTheDocument();
    });
  });

  it("sends ONE bulk POST carrying every staged scope, across every type, and clears the pickers on success", async () => {
    const user = userEvent.setup();
    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => screen.getByText(/add scopes/i));

    await user.click(screen.getByRole("button", { name: /add agents/i }));
    await user.click(await screen.findByRole("button", { name: "SRE Agent" }));
    await user.click(screen.getByText(/owned by one of your teams|set the starting access/i));

    await user.click(screen.getByRole("button", { name: /add datasources/i }));
    await user.click(await screen.findByRole("button", { name: "Datasource One" }));
    await user.click(screen.getByText(/owned by one of your teams|set the starting access/i));

    await user.click(screen.getByRole("button", { name: /^add$/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/admin/service-accounts/${encodeURIComponent(ANON_SA.id)}/scopes/bulk`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            scopes: [
              { type: "agent", ref: "sre-agent" },
              { type: "datasource", ref: "ds-1" },
            ],
          }),
        }),
      );
    });
    // Exactly one bulk call — not one POST per scope.
    const bulkCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([href]) => String(href).endsWith("/scopes/bulk"),
    );
    expect(bulkCalls).toHaveLength(1);

    // Pickers reset back to their empty placeholder after a successful Add.
    expect(screen.getByRole("button", { name: /add agents/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add datasources/i })).toBeInTheDocument();
  });

  it("shows an 'Adding N scopes' progress label immediately on click, clearing when done", async () => {
    const user = userEvent.setup();
    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => screen.getByText(/add scopes/i));
    await user.click(screen.getByRole("button", { name: /add agents/i }));
    await user.click(await screen.findByRole("button", { name: "SRE Agent" }));
    await user.click(screen.getByText(/owned by one of your teams|set the starting access/i));
    await user.click(screen.getByRole("button", { name: /add datasources/i }));
    await user.click(await screen.findByRole("button", { name: "Datasource One" }));
    await user.click(screen.getByText(/owned by one of your teams|set the starting access/i));

    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    // Visible the instant Add is clicked, not just once the bulk request
    // resolves, so even a large batch never looks hung at the start.
    expect(screen.getByText(/adding 2 scopes\.\.\./i)).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.queryByText(/adding \d+ scopes?\.\.\./i)).not.toBeInTheDocument(),
    );
  });

  it("adds a collection scope, and always shows the search-filter-only note", async () => {
    const user = userEvent.setup();
    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => screen.getByText(/add scopes/i));
    expect(
      screen.getByText(/does not grant access to its member datasources/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /add collections/i }));
    await user.click(await screen.findByRole("button", { name: "Collection One" }));
    await user.click(screen.getByText(/owned by one of your teams|set the starting access/i));
    await user.click(screen.getByRole("button", { name: /^add$/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/admin/service-accounts/${encodeURIComponent(ANON_SA.id)}/scopes/bulk`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ scopes: [{ type: "collection", ref: "coll-1" }] }),
        }),
      );
    });
  });

  it("shows a single error banner when the bulk Add fails", async () => {
    mockFetch({
      scopePost: { success: false, error: "You cannot grant a scope you do not hold" },
    });
    const user = userEvent.setup();

    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => screen.getByText(/add scopes/i));
    await user.click(screen.getByRole("button", { name: /add agents/i }));
    await user.click(await screen.findByRole("button", { name: "SRE Agent" }));
    await user.click(screen.getByText(/owned by one of your teams|set the starting access/i));
    await user.click(screen.getByRole("button", { name: /^add$/i }));

    await waitFor(() => {
      const errors = screen.getAllByTestId("unlinked-modal-error");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toHaveTextContent(/cannot grant a scope you do not hold/i);
    });
  });

  it("shows confirm flow before DELETE and sends DELETE on confirm", async () => {
    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/remove agent hello-world/i)).toBeInTheDocument();
    });

    // Click the remove button to enter confirm flow
    fireEvent.click(screen.getByLabelText(/remove agent hello-world/i));
    expect(screen.getByText(/remove\?/i)).toBeInTheDocument();

    // Confirm the removal
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/admin/service-accounts/${encodeURIComponent(ANON_SA.id)}/scopes`,
        expect.objectContaining({
          method: "DELETE",
          body: JSON.stringify({ type: "agent", ref: "hello-world" }),
        }),
      );
    });
  });

  it("shows an error when the resolver returns an error", async () => {
    mockFetch({
      sa: {
        success: false,
        error: "Unlinked service account not found or not yet bootstrapped",
      },
    });

    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("unlinked-modal-error")).toHaveTextContent(
        /unlinked service account not found/i,
      );
    });
  });

  it("calls onOpenChange(false) when the Close button in the footer is clicked", async () => {
    const onOpenChange = jest.fn();
    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={onOpenChange} />,
    );

    await waitFor(() => screen.getByTestId("scope-agent-hello-world"));

    // Use data-testid to get the specific footer Close button
    const closeBtn = screen.getByTestId("unlinked-modal-close");
    fireEvent.click(closeBtn);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not show a Current-scopes filter input for a short scope list", async () => {
    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => screen.getByTestId("scope-agent-hello-world"));
    expect(
      screen.queryByRole("textbox", { name: /filter current scopes/i }),
    ).not.toBeInTheDocument();
  });

  it("shows a Current-scopes filter input for a long scope list, and filters by it", async () => {
    const manyScopes = Array.from({ length: 12 }, (_, i) => ({
      type: "datasource" as const,
      ref: `bulk-ds-${i + 1}`,
    }));
    mockFetch({
      sa: { success: true, data: { ...ANON_SA, scopes: manyScopes } },
    });
    const user = userEvent.setup();

    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => screen.getByTestId("scope-datasource-bulk-ds-1"));
    expect(screen.getByTestId("scope-datasource-bulk-ds-12")).toBeInTheDocument();

    const filterInput = screen.getByRole("textbox", { name: /filter current scopes/i });
    await user.type(filterInput, "bulk-ds-7");

    expect(screen.getByTestId("scope-datasource-bulk-ds-7")).toBeInTheDocument();
    expect(screen.queryByTestId("scope-datasource-bulk-ds-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("scope-datasource-bulk-ds-12")).not.toBeInTheDocument();
  });
});

// ── Add datasources from a collection (stages, never applies immediately) ──

describe("UnlinkedServiceAccountModal — bulk-add datasources from a collection", () => {
  it("stages addable member datasources into the Datasources picker instead of POSTing immediately", async () => {
    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => screen.getByRole("combobox", { name: /add datasources from a collection/i }));
    fireEvent.click(
      screen.getByRole("combobox", { name: /add datasources from a collection/i }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "Collection One" }));

    await waitFor(() => {
      expect(
        screen.getByText(/queued 2 datasources from the collection.*click add to apply/i),
      ).toBeInTheDocument();
    });
    // Staged into the Datasources picker as selected badges — not POSTed yet.
    expect(screen.getByText("Datasource One")).toBeInTheDocument();
    expect(screen.getByText("Datasource Two")).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/scopes"),
      expect.objectContaining({ method: "POST" }),
    );

    // Clicking Add is what actually applies it — as one bulk call.
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/admin/service-accounts/${encodeURIComponent(ANON_SA.id)}/scopes/bulk`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            scopes: [
              { type: "datasource", ref: "ds-1" },
              { type: "datasource", ref: "ds-2" },
            ],
          }),
        }),
      );
    });
    // The non-grantable member id must never be included, and the
    // collection itself must never be added.
    const bulkBody = JSON.parse(
      String(
        (global.fetch as jest.Mock).mock.calls.find(([href]) =>
          String(href).endsWith("/scopes/bulk"),
        )?.[1]?.body,
      ),
    );
    expect(bulkBody.scopes).not.toEqual(
      expect.arrayContaining([{ type: "datasource", ref: "ds-not-grantable" }]),
    );
    expect(bulkBody.scopes).not.toEqual(
      expect.arrayContaining([{ type: "collection", ref: "coll-1" }]),
    );
  });

  it("excludes datasources already granted to the unlinked SA", async () => {
    mockFetch({
      sa: {
        success: true,
        data: { ...ANON_SA, scopes: [...ANON_SA.scopes, { type: "datasource", ref: "ds-1" }] },
      },
    });

    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => screen.getByRole("combobox", { name: /add datasources from a collection/i }));
    fireEvent.click(
      screen.getByRole("combobox", { name: /add datasources from a collection/i }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "Collection One" }));

    await waitFor(() => {
      expect(
        screen.getByText(/queued 1 datasource from the collection.*click add to apply/i),
      ).toBeInTheDocument();
    });
  });

  it("is idempotent: picking the same collection twice before Add only queues each member once", async () => {
    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => screen.getByRole("combobox", { name: /add datasources from a collection/i }));
    const picker = screen.getByRole("combobox", {
      name: /add datasources from a collection/i,
    });

    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("option", { name: "Collection One" }));
    await waitFor(() =>
      expect(screen.getByText(/queued 2 datasources/i)).toBeInTheDocument(),
    );

    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("option", { name: "Collection One" }));
    await waitFor(() =>
      expect(
        screen.getByText(/no datasources you can grant are in that collection/i),
      ).toBeInTheDocument(),
    );

    // Still exactly one badge per datasource — the second pick queued nothing new.
    expect(screen.getAllByText("Datasource One")).toHaveLength(1);
    expect(screen.getAllByText("Datasource Two")).toHaveLength(1);
  });

  it("shows a note when no datasources in the collection are grantable", async () => {
    mockFetch({
      collectionMembers: { success: true, data: { source_ids: ["ds-not-grantable"] } },
    });

    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => screen.getByRole("combobox", { name: /add datasources from a collection/i }));
    fireEvent.click(
      screen.getByRole("combobox", { name: /add datasources from a collection/i }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "Collection One" }));

    await waitFor(() => {
      expect(
        screen.getByText(/no datasources you can grant are in that collection/i),
      ).toBeInTheDocument();
    });
  });

  it("shows an error note when the collection fetch fails", async () => {
    mockFetch({
      collectionMembers: { success: false, error: "Collection not found" },
    });

    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => screen.getByRole("combobox", { name: /add datasources from a collection/i }));
    fireEvent.click(
      screen.getByRole("combobox", { name: /add datasources from a collection/i }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "Collection One" }));

    await waitFor(() => {
      expect(screen.getByText(/collection not found/i)).toBeInTheDocument();
    });
  });

  it("disables the bulk-add picker while a previous pick is still resolving", async () => {
    let resolveCollectionFetch: ((value: unknown) => void) | undefined;
    const pendingCollectionFetch = new Promise((resolve) => {
      resolveCollectionFetch = resolve;
    });
    global.fetch = jest.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method?.toUpperCase() ?? "GET";
      if (href.includes("/api/admin/service-accounts/unlinked")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: ANON_SA }),
        } as Response);
      }
      if (href.includes("/api/admin/service-accounts/grantable")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: GRANTABLE }),
        } as Response);
      }
      if (href.includes("/api/rag/collections/") && method === "GET") {
        return pendingCollectionFetch.then(
          () => ({ ok: true, json: () => Promise.resolve(COLLECTION_MEMBERS) } as Response),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${href} [${method}]`));
    });

    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => screen.getByRole("combobox", { name: /add datasources from a collection/i }));
    const picker = screen.getByRole("combobox", {
      name: /add datasources from a collection/i,
    });
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("option", { name: "Collection One" }));

    expect(picker).toBeDisabled();

    resolveCollectionFetch?.(undefined);
    await waitFor(() =>
      expect(screen.getByText(/queued 2 datasources/i)).toBeInTheDocument(),
    );
    expect(picker).not.toBeDisabled();
  });

  it("disables the bulk-add picker when there are no grantable collections", async () => {
    mockFetch({
      grantable: { success: true, data: { ...GRANTABLE, collections: [] } },
    });

    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => screen.getByRole("combobox", { name: /add datasources from a collection/i }));
    expect(
      screen.getByRole("combobox", { name: /add datasources from a collection/i }),
    ).toBeDisabled();
  });

  it("keeps a collection available in the bulk-add picker even after it has already been granted as a scope", async () => {
    // Granting a collection to the unlinked SA is a search-filter-only scope
    // and is unrelated to whether its member datasources can still be
    // bulk-added — the collection must not disappear from the bulk-add
    // picker just because it's already a direct grant.
    mockFetch({
      sa: {
        success: true,
        data: { ...ANON_SA, scopes: [...ANON_SA.scopes, { type: "collection", ref: "coll-1" }] },
      },
    });

    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => screen.getByRole("combobox", { name: /add datasources from a collection/i }));
    const picker = screen.getByRole("combobox", {
      name: /add datasources from a collection/i,
    });
    expect(picker).not.toBeDisabled();
    fireEvent.click(picker);
    expect(await screen.findByRole("option", { name: "Collection One" })).toBeInTheDocument();
  });
});

// ── TEST-11 / UX-5 (grantable-fetch failure banner still applies) ──────────

describe("UnlinkedServiceAccountModal — grantable fetch failure (TEST-11/UX-5)", () => {
  it("shows grantable-fetch failure banner when grantable fetch fails (not just empty)", async () => {
    mockFetch({
      grantable: { success: false, error: "Failed to load grantable scopes" },
    });

    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("unlinked-modal-grantable-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("unlinked-modal-grantable-error")).toHaveTextContent(
      /failed to load grantable scopes/i,
    );
    // The grantable error banner must be distinct from the SA error banner
    expect(screen.queryByTestId("unlinked-modal-error")).not.toBeInTheDocument();
  });

  it("shows grantable-fetch failure when fetch throws (network error)", async () => {
    global.fetch = jest.fn((url: RequestInfo | URL) => {
      const href = String(url);
      if (href.includes("/api/admin/service-accounts/unlinked")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: ANON_SA }),
        } as Response);
      }
      if (href.includes("/api/admin/service-accounts/grantable")) {
        return Promise.reject(new Error("Network error"));
      }
      return Promise.reject(new Error("Unexpected fetch"));
    });

    render(
      <UnlinkedServiceAccountModal open isAdmin onOpenChange={jest.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("unlinked-modal-grantable-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("unlinked-modal-grantable-error")).toHaveTextContent(
      /network error/i,
    );
  });
});
