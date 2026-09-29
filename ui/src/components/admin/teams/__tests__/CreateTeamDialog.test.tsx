import { render, screen, waitFor } from "@testing-library/react";
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
