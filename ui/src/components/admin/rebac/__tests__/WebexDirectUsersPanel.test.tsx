import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockToast = jest.fn();
jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

import { WebexDirectUsersPanel } from "../WebexDirectUsersPanel";

const fetchMock = jest.fn();

function response(payload: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

function botsResponse() {
  return response({
    data: {
      bots: [
        { id: "primary", name: "Primary bot", available: true },
        { id: "secondary", name: "Secondary bot", available: true },
      ],
    },
  });
}

function agentsResponse() {
  return response({ data: { items: [], has_more: false } });
}

interface UserFixture {
  id: string;
  email: string;
}

function usersPage(
  botId: string,
  page: number,
  users: UserFixture[],
  total: number,
): Response {
  return response({
    data: {
      users: users.map((user) => ({
        keycloak_user_id: user.id,
        email: user.email,
        display_name: user.id,
        linked: false,
        enabled: false,
        configured: false,
        inherited: false,
        state: "not_allowed",
        agent_id: "",
      })),
      bot_id: botId,
      dm_access_mode: "allowlist",
      default_agent_id: null,
      total,
      page,
      page_size: 25,
      has_more: page * 25 < total,
    },
  });
}

interface PendingDirectUsersCall {
  url: string;
  resolve: (value: Response) => void;
}

let pendingDirectUsersCalls: PendingDirectUsersCall[];

function setupFetchMock() {
  pendingDirectUsersCalls = [];
  fetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/admin/webex/bots") return botsResponse();
    if (String(url).startsWith("/api/dynamic-agents")) return agentsResponse();
    if (String(url).startsWith("/api/admin/webex/direct-users")) {
      return new Promise<Response>((resolve) => {
        pendingDirectUsersCalls.push({ url: String(url), resolve });
      });
    }
    return response({});
  });
}

beforeEach(() => {
  mockToast.mockClear();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  setupFetchMock();
});

it("keeps the newly selected bot's users after the previous bot's stale request resolves late", async () => {
  render(<WebexDirectUsersPanel />);

  await waitFor(() => expect(pendingDirectUsersCalls).toHaveLength(1));
  expect(pendingDirectUsersCalls[0].url).toContain("bot_id=primary");

  fireEvent.click(screen.getByRole("combobox", { name: "Webex bot" }));
  fireEvent.click(await screen.findByRole("option", { name: "Secondary bot" }));

  await waitFor(() => expect(pendingDirectUsersCalls).toHaveLength(2));
  expect(pendingDirectUsersCalls[1].url).toContain("bot_id=secondary");

  // Newer (secondary) request resolves first, then the stale (primary) request
  // resolves late — the stale response must not overwrite the newer rows.
  pendingDirectUsersCalls[1].resolve(
    usersPage("secondary", 1, [{ id: "user-2", email: "secondary-user@example.com" }], 1),
  );
  await screen.findByText("secondary-user@example.com");

  pendingDirectUsersCalls[0].resolve(
    usersPage("primary", 1, [{ id: "user-1", email: "primary-user@example.com" }], 1),
  );

  await waitFor(() => {
    expect(screen.queryByText("primary-user@example.com")).not.toBeInTheDocument();
  });
  expect(screen.getByText("secondary-user@example.com")).toBeInTheDocument();
});

it("keeps the newer request's rows when an earlier, still in-flight request resolves after it", async () => {
  render(<WebexDirectUsersPanel />);

  await waitFor(() => expect(pendingDirectUsersCalls).toHaveLength(1));
  pendingDirectUsersCalls[0].resolve(
    usersPage(
      "primary",
      1,
      [{ id: "user-1", email: "page1-user@example.com" }],
      60,
    ),
  );
  await screen.findByText("page1-user@example.com");

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(pendingDirectUsersCalls).toHaveLength(2));
  expect(pendingDirectUsersCalls[1].url).toContain("page=2");

  // While the page-2 request is still in flight — the table is replaced by a
  // spinner and Prev/Next disable, but the search box stays interactive —
  // start a new search. That resets back to page 1 and fires a newer,
  // still-pending request.
  fireEvent.change(
    screen.getByRole("textbox", { name: "Search deployment users" }),
    { target: { value: "example" } },
  );
  await waitFor(() => expect(pendingDirectUsersCalls).toHaveLength(3));
  expect(pendingDirectUsersCalls[2].url).toContain("page=1");
  expect(pendingDirectUsersCalls[2].url).toContain("q=example");

  // The newer (search) request resolves first, then the stale page-2 request
  // resolves after it — the stale, earlier request must not overwrite the
  // newer rows.
  pendingDirectUsersCalls[2].resolve(
    usersPage("primary", 1, [{ id: "user-3", email: "search-user@example.com" }], 1),
  );
  await screen.findByText("search-user@example.com");

  pendingDirectUsersCalls[1].resolve(
    usersPage("primary", 2, [{ id: "user-2", email: "page2-user@example.com" }], 60),
  );

  await waitFor(() => {
    expect(screen.queryByText("page2-user@example.com")).not.toBeInTheDocument();
  });
  expect(screen.getByText("search-user@example.com")).toBeInTheDocument();
});

it("fires a single request for the new search term instead of one for the stale page followed by a correction", async () => {
  render(<WebexDirectUsersPanel />);

  await waitFor(() => expect(pendingDirectUsersCalls).toHaveLength(1));
  pendingDirectUsersCalls[0].resolve(
    usersPage(
      "primary",
      1,
      [{ id: "user-1", email: "page1-user@example.com" }],
      60,
    ),
  );
  await screen.findByText("page1-user@example.com");

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(pendingDirectUsersCalls).toHaveLength(2));
  pendingDirectUsersCalls[1].resolve(
    usersPage("primary", 2, [{ id: "user-2", email: "page2-user@example.com" }], 60),
  );
  await screen.findByText("page2-user@example.com");

  fireEvent.change(
    screen.getByRole("textbox", { name: "Search deployment users" }),
    { target: { value: "example" } },
  );

  await waitFor(() => expect(pendingDirectUsersCalls).toHaveLength(3));
  // Only one request should have been made for the new search term, and it
  // must be for page 1 — not page 2 (the stale page carried over from before
  // the search term changed).
  const searchCalls = pendingDirectUsersCalls.filter((call) => call.url.includes("q=example"));
  expect(searchCalls).toHaveLength(1);
  expect(searchCalls[0].url).toContain("page=1");
});
