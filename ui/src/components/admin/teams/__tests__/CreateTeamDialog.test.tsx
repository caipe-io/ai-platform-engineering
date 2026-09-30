import { fireEvent,render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CreateTeamDialog } from "../CreateTeamDialog";

const fetchMock = jest.fn();

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

function isUsersGet(url: string): boolean {
  return url.startsWith("/api/admin/users");
}

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

it("browses the first page of users by default without a query", async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async (url: string) => {
    if (isUsersGet(url)) {
      expect(url).toContain("pageSize=100");
      expect(url).not.toContain("search=");
      return jsonResponse({
        users: [{ email: "alice@example.com" }, { email: "bob@example.com" }],
      });
    }
    return jsonResponse({ success: true, data: {} });
  });

  render(
    <CreateTeamDialog open onOpenChange={jest.fn()} onSuccess={jest.fn()} />,
  );

  await user.click(
    screen.getByRole("button", { name: /search and select members/i }),
  );

  expect(
    await screen.findByRole("button", { name: /alice@example\.com/i }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /bob@example\.com/i }),
  ).toBeInTheDocument();
});

// Regression guard: previously the search box only filtered the 100 users
// fetched on open, so an admin could never find/add a user outside that
// first page. Typing a query must now hit the API and search every user.
it("searches the full user directory instead of only the loaded first page", async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async (url: string) => {
    if (isUsersGet(url)) {
      if (url.includes("search=zoe")) {
        return jsonResponse({ users: [{ email: "zoe@example.com" }] });
      }
      return jsonResponse({
        users: [{ email: "alice@example.com" }, { email: "bob@example.com" }],
      });
    }
    return jsonResponse({ success: true, data: {} });
  });

  render(
    <CreateTeamDialog open onOpenChange={jest.fn()} onSuccess={jest.fn()} />,
  );

  await user.click(
    screen.getByRole("button", { name: /search and select members/i }),
  );
  await screen.findByRole("button", { name: /alice@example\.com/i });

  await user.type(
    screen.getByPlaceholderText("Search by name or email..."),
    "zoe",
  );

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("search=zoe"),
      expect.anything(),
    ),
  );

  expect(
    await screen.findByRole("button", { name: /zoe@example\.com/i }),
  ).toBeInTheDocument();
  // alice/bob came from the unrelated first page fetch, not the search
  // results — they must not leak into the searched list.
  expect(
    screen.queryByRole("button", { name: /alice@example\.com/i }),
  ).not.toBeInTheDocument();
});

// Regression guard: MultiSelect doesn't filter `options` itself in
// server-search mode, so a stale match from the *previous* query used to
// stay selectable while the new query was still debouncing/in flight.
it("clears the previous query's results as soon as a new search starts", async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async (url: string) => {
    if (isUsersGet(url)) {
      if (url.includes("search=zoe")) {
        return jsonResponse({ users: [{ email: "zoe@example.com" }] });
      }
      return jsonResponse({ users: [{ email: "alice@example.com" }] });
    }
    return jsonResponse({ success: true, data: {} });
  });

  render(
    <CreateTeamDialog open onOpenChange={jest.fn()} onSuccess={jest.fn()} />,
  );

  await user.click(
    screen.getByRole("button", { name: /search and select members/i }),
  );

  const search = screen.getByPlaceholderText("Search by name or email...");
  await user.type(search, "zoe");
  expect(
    await screen.findByRole("button", { name: /zoe@example\.com/i }),
  ).toBeInTheDocument();

  // Go straight from "zoe" to "alice" without passing through the <2-char
  // empty state, and check *before* the new fetch/debounce settles — the
  // stale "zoe" option must already be gone, not just eventually replaced.
  fireEvent.change(search, { target: { value: "alice" } });
  expect(
    screen.queryByRole("button", { name: /zoe@example\.com/i }),
  ).not.toBeInTheDocument();

  expect(
    await screen.findByRole("button", { name: /alice@example\.com/i }),
  ).toBeInTheDocument();
});

// Regression guard: a failed search used to fall through to the same
// "No users found" empty state as a genuine zero-match search, misleading
// the admin into thinking the search completed rather than errored.
it("shows a distinct failure message and logs the error when a search request fails", async () => {
  const user = userEvent.setup();
  const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  fetchMock.mockImplementation(async (url: string) => {
    if (isUsersGet(url)) {
      if (url.includes("search=err")) {
        throw new Error("network down");
      }
      return jsonResponse({ users: [] });
    }
    return jsonResponse({ success: true, data: {} });
  });

  render(
    <CreateTeamDialog open onOpenChange={jest.fn()} onSuccess={jest.fn()} />,
  );

  await user.click(
    screen.getByRole("button", { name: /search and select members/i }),
  );
  await user.type(
    screen.getByPlaceholderText("Search by name or email..."),
    "err",
  );

  expect(await screen.findByText("Search failed — try again")).toBeInTheDocument();
  expect(screen.queryByText("No users found")).not.toBeInTheDocument();
  expect(consoleErrorSpy).toHaveBeenCalledWith(
    "[CreateTeamDialog] Member search failed:",
    expect.anything(),
  );

  consoleErrorSpy.mockRestore();
});

// Regression guard: onSearchChange puts MultiSelect into a mode where it no
// longer filters `options` itself — selecting a result must still work.
it("selects a server-searched result and submits it as a team member", async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (isUsersGet(url)) {
      if (url.includes("search=zoe")) {
        return jsonResponse({ users: [{ email: "zoe@example.com" }] });
      }
      return jsonResponse({ users: [] });
    }
    if (url === "/api/admin/teams" && init?.method === "POST") {
      return jsonResponse({ success: true, data: {} });
    }
    return jsonResponse({ success: true, data: {} });
  });

  render(
    <CreateTeamDialog open onOpenChange={jest.fn()} onSuccess={jest.fn()} />,
  );

  await user.click(
    screen.getByRole("button", { name: /search and select members/i }),
  );
  await user.type(
    screen.getByPlaceholderText("Search by name or email..."),
    "zoe",
  );
  await user.click(
    await screen.findByRole("button", { name: /zoe@example\.com/i }),
  );

  await user.type(screen.getByLabelText(/team name/i), "Platform");
  await user.click(screen.getByRole("button", { name: /create team/i }));

  await waitFor(() => {
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/admin/teams" && (init as RequestInit)?.method === "POST",
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.members).toEqual(["zoe@example.com"]);
  });
});
