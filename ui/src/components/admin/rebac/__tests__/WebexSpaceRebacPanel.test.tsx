import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mockToast = jest.fn();
jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

const replaceMock = jest.fn();
let currentSearchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  usePathname: () => "/admin",
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => currentSearchParams,
}));

import { WebexSpaceRebacPanel } from "../WebexSpaceRebacPanel";
import { pickTeam } from "@/__test-utils__/team-picker";
import { pickAgent } from "@/__test-utils__/agent-picker";

const fetchMock = jest.fn();

function setupFetchMock() {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/admin/webex/spaces?health=1")) {
      return response({
        data: {
          spaces: [
            {
              workspace_id: "WEBEX-WORKSPACE",
              space_id: "space-abc",
              space_name: "Platform Alerts",
              team_slug: "platform-engineering",
              primary_agent_id: "incident-agent",
              bot_id: "primary",
              active_grants: 1,
            },
          ],
        },
      });
    }
    if (String(url).startsWith("/api/admin/webex/available-spaces")) {
      return response({
        data: {
          spaces: [
            {
              id: "space-abc",
              name: "Platform Alerts",
              type: "group",
              is_locked: false,
              available_bot_ids: ["primary", "secondary"],
            },
            {
              id: "space-new-123",
              name: "Incident War Room",
              type: "group",
              is_locked: false,
              available_bot_ids: ["primary", "secondary"],
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      });
    }
    if (url === "/api/admin/webex/bots") {
      return response({
        data: {
          bots: [
            { id: "primary", name: "Primary bot", available: true },
            {
              id: "secondary",
              name: "Secondary bot",
              available: true,
            },
          ],
        },
      });
    }
    if (url.startsWith("/api/dynamic-agents?enabled_only=true")) {
      return response({
        data: {
          items: [
            { _id: "test-april-2025", name: "Test April 2025" },
            { _id: "incident-agent", name: "Incident Agent" },
            { _id: "fallback-agent", name: "Fallback Agent" },
          ],
        },
      });
    }
    if (String(url).startsWith("/api/admin/webex/direct-users")) {
      if (init?.method === "PUT" || init?.method === "DELETE") {
        return response({ data: { saved: init.method === "PUT", deleted: init.method === "DELETE" } });
      }
      return response({
        data: {
          users: [
            {
              keycloak_user_id: "user-1",
              email: "user@example.com",
              display_name: "Example User",
              linked: false,
              enabled: false,
              configured: false,
              inherited: false,
              state: "not_allowed",
              agent_id: "",
            },
          ],
          bot_id: "primary",
          dm_access_mode: "allowlist",
          default_agent_id: null,
        },
      });
    }
    if (url === "/api/dynamic-agents/teams") {
      return response({
        success: true,
        data: [
          {
            _id: "team-1",
            slug: "platform-engineering",
            name: "Platform Engineering",
          },
        ],
      });
    }
    if (url === "/api/admin/webex/spaces/defaults" && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      return response({
        data: {
          summary: {
            spaces_seen: body.manual_spaces?.length ?? 1,
            spaces_assigned_team: body.manual_spaces?.length ?? 1,
            space_grants_ensured: body.manual_spaces?.length ?? 1,
            routes_ensured: body.manual_spaces?.length ?? 1,
            spaces_manual: body.manual_spaces?.length ?? 0,
            spaces_onboarded: body.manual_spaces?.length ?? 0,
            routes_preserved: 0,
          },
        },
      });
    }
    if (url === "/api/admin/webex/spaces/onboard" && init?.method === "POST") {
      return response({ data: { onboarded: true } });
    }
    if (url === "/api/admin/webex/spaces/defaults" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body ?? "{}"));
      return response({
        data: {
          defaults: {
            ...body,
            source: "db",
            updated_at: "2026-05-27T08:00:00.000Z",
            updated_by: "admin@example.com",
          },
        },
      });
    }
    if (url === "/api/admin/webex/spaces/defaults") {
      return response({
        data: {
          defaults: {
            team_slug: "platform-engineering",
            agent_id: "incident-agent",
          },
        },
      });
    }
    if (url === "/api/admin/webex/runtime/status") {
      return response({
        data: {
          route_mode: "db_prefer",
          static_config: { spaces: 1, routes: 1 },
          route_cache: { ttl_seconds: 60, cache_size: 1 },
          thread_context: { enabled: true, max_messages: 10, max_chars: 4000 },
        },
      });
    }
    if (url === "/api/admin/webex/runtime/reload") {
      return response({ data: { reloaded: "all" } });
    }
    if (url === "/api/admin/webex/runtime/sync-from-config") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return response({
        data: {
          dry_run: Boolean(body.dry_run),
          spaces_seen: 1,
          routes_planned: 1,
          routes_upserted: body.dry_run ? 0 : 1,
          openfga_tuples_written: body.dry_run ? 0 : 1,
        },
      });
    }
    if (String(url).includes("/routes?") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body ?? "{}"));
      return response({ data: { routes: body.routes } });
    }
    if (String(url).includes("/routes?") && init?.method === "DELETE") {
      return response({ data: { deleted: { agent_id: "foo-bar" } } });
    }
    if (String(url).includes("/routes?")) {
      return response({
        data: {
          routes: [
            {
              agent_id: "incident-agent",
              enabled: true,
              priority: 100,
              users: { enabled: true, listen: "mention" },
            },
          ],
        },
      });
    }
    if (String(url).includes("/diagnostics?")) {
      return response({
        data: {
          openfga: { reachable: true, tuple_count: 1 },
          warnings: [
            "agent:foo-bar has Mongo route metadata, but the OpenFGA tuple is missing; runtime ignores it.",
          ],
          routes: [
            {
              agent_id: "foo-bar",
              openfga_tuple: false,
              route_metadata: true,
              listen: "message",
              runtime_matches: { mention: false, message: true },
              warnings: [],
            },
            {
              agent_id: "incident-agent",
              openfga_tuple: true,
              route_metadata: true,
              listen: "mention",
              runtime_matches: { mention: true, message: false },
              warnings: [],
            },
          ],
          last_runtime_error: {
            ts: "2026-05-18T07:50:00.000Z",
            reason_code: "OPENFGA_READ_FAILED",
            message: "OpenFGA tuple read failed",
          },
        },
      });
    }
    if (
      String(url).startsWith("/api/admin/webex/spaces/WEBEX-WORKSPACE/space-abc?") &&
      init?.method === "DELETE"
    ) {
      return response({ data: { deleted: { space_id: "space-abc" } } });
    }
    return response({});
  });
}

beforeEach(() => {
  mockToast.mockClear();
  replaceMock.mockReset();
  currentSearchParams = new URLSearchParams();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  setupFetchMock();
});

afterEach(() => {
  jest.useRealTimers();
});

function response(payload: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

async function ensureConfigureSpacesTabActive() {
  const tab = await screen.findByRole("tab", { name: "Configure spaces" });
  if (tab.getAttribute("aria-selected") !== "true") {
    fireEvent.click(tab);
  }
}

async function clickFindSpaces() {
  await ensureConfigureSpacesTabActive();
  const discoverButton = await screen.findByRole("button", {
    name: "Find spaces",
  });
  await waitFor(() => expect(discoverButton).toBeEnabled());
  fireEvent.click(discoverButton);
}

async function clickRefreshSpaces() {
  const refreshButton = await screen.findByRole("button", {
    name: "Refresh spaces",
  });
  await waitFor(() => expect(refreshButton).toBeEnabled());
  fireEvent.click(refreshButton);
}

it("scopes the configured space list to the simulated user", async () => {
  render(
    <WebexSpaceRebacPanel
      selfService
      disabled
      simulationTarget={{ type: "user", id: "target-sub" }}
    />,
  );

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/webex/spaces?simulate_type=user&simulate_id=target-sub&health=1&bot_id=primary",
    );
  });
});

it("shows the onboarding loading state while configured spaces seed the table", async () => {
  let resolveSpaces: ((value: Response) => void) | undefined;
  const spacesPromise = new Promise<Response>((resolve) => {
    resolveSpaces = resolve;
  });
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).startsWith("/api/admin/webex/spaces?health=1")) {
      return spacesPromise;
    }
    if (url.startsWith("/api/dynamic-agents?enabled_only=true")) {
      return response({ data: { items: [] } });
    }
    return response({});
  });

  render(<WebexSpaceRebacPanel />);
  // Query synchronously (no `findBy`/await) so this capture happens on the
  // same tick as render, before the mocked bots/dynamic-agents fetches
  // resolve — matching the timing this test is actually asserting on.
  fireEvent.click(screen.getByRole("tab", { name: "Configure spaces" }));
  expect(screen.getByTestId("discovery-loading")).toBeInTheDocument();
  expect(screen.getByText("Loading configured spaces…")).toBeInTheDocument();
  expect(
    screen.queryByText("No spaces configured yet."),
  ).not.toBeInTheDocument();

  resolveSpaces?.(response({ data: { spaces: [] } }));
  await waitFor(() =>
    expect(screen.queryByTestId("discovery-loading")).not.toBeInTheDocument(),
  );
});

// ── Single onboarding layout ────────────────────────────────────────────────

it("renders Webex with Configure, Configured, 1:1, and Advanced tabs", async () => {
  render(<WebexSpaceRebacPanel />);

  // Default landing tab is "Configured spaces", matching Slack's tab order
  expect(
    await screen.findByRole("tab", { name: "Configured spaces" }),
  ).toHaveAttribute("aria-selected", "true");
  // "Configure spaces" tab is present for navigating to onboarding
  expect(
    screen.getByRole("tab", { name: "Configure spaces" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "1:1 Messages" })).toBeInTheDocument();
  // The Advanced tab is present, at the end of the switcher.
  expect(screen.getByRole("tab", { name: "Advanced" })).toBeInTheDocument();
  // Configured table renders on the default tab
  expect(
    await screen.findByRole("region", { name: "Configured Webex spaces" }),
  ).toBeInTheDocument();
  // Onboarding-only controls and the Advanced section are not visible on the default tab
  expect(
    screen.queryByRole("button", { name: "Find spaces" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("region", {
      name: "Advanced Setup - Import/Sync with Webex Bot",
    }),
  ).not.toBeInTheDocument();
});

it("shows only the Reload Bot Cache action on the Webex Advanced tab", async () => {
  render(<WebexSpaceRebacPanel />);

  fireEvent.click(await screen.findByRole("tab", { name: "Advanced" }));

  expect(
    await screen.findByRole("region", {
      name: "Advanced Setup - Import/Sync with Webex Bot",
    }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reload Bot Cache" })).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Refresh Runtime Status" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Import from YAML" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Route mode")).not.toBeInTheDocument();
});

it("never fetches runtime status because Webex's Advanced tab is minimal", async () => {
  render(<WebexSpaceRebacPanel />);

  await screen.findByRole("region", { name: "Configured Webex spaces" });
  fireEvent.click(await screen.findByRole("tab", { name: "Advanced" }));
  await screen.findByRole("button", { name: "Reload Bot Cache" });

  expect(
    fetchMock.mock.calls.some(([url]) => url === "/api/admin/webex/runtime/status"),
  ).toBe(false);
});

it("opens Configure spaces from the empty configured-spaces action", async () => {
  const baseFetch = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/admin/webex/spaces?health=1")) {
      return response({ data: { spaces: [] } });
    }
    return baseFetch?.(url, init) ?? response({});
  });

  render(<WebexSpaceRebacPanel />);
  fireEvent.click(await screen.findByRole("tab", { name: "Configured spaces" }));
  fireEvent.click(await screen.findByRole("button", { name: "Onboard spaces" }));

  expect(screen.getByRole("tab", { name: "Configure spaces" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("button", { name: "Find spaces" })).toBeInTheDocument();
});

it("refreshes configured spaces when the tab opens and on explicit refresh", async () => {
  render(<WebexSpaceRebacPanel />);

  await screen.findByRole("region", { name: "Configured Webex spaces" });
  fireEvent.click(screen.getByRole("tab", { name: "Configure spaces" }));
  await screen.findByRole("button", { name: "Find spaces" });
  const callsBeforeTab = fetchMock.mock.calls.filter(([url]) =>
    String(url).startsWith("/api/admin/webex/spaces?health=1"),
  ).length;

  fireEvent.click(screen.getByRole("tab", { name: "Configured spaces" }));
  await waitFor(() => expect(
    fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith("/api/admin/webex/spaces?health=1"),
    ).length,
  ).toBeGreaterThan(callsBeforeTab));

  const callsBeforeRefresh = fetchMock.mock.calls.filter(([url]) =>
    String(url).startsWith("/api/admin/webex/spaces?health=1"),
  ).length;
  fireEvent.click(await screen.findByRole("button", { name: "Refresh configured spaces" }));
  await waitFor(() => expect(
    fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith("/api/admin/webex/spaces?health=1"),
    ).length,
  ).toBeGreaterThan(callsBeforeRefresh));
});

it("falls back to the default configured-spaces tab for a subtab value foreign to Webex", async () => {
  // "migration" is a valid subtab for other connectors but Webex has no
  // migration panel, so it must not be treated as one of this switcher's values.
  currentSearchParams = new URLSearchParams("subtab=migration");
  render(<WebexSpaceRebacPanel />);

  expect(
    await screen.findByRole("tab", { name: "Configured spaces" }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    screen.queryByRole("button", { name: "Find spaces" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("region", {
      name: "Advanced Setup - Import/Sync with Webex Bot",
    }),
  ).not.toBeInTheDocument();
  expect(replaceMock).not.toHaveBeenCalled();
});

it.each([
  ["onboard", "Configure spaces"],
  ["direct", "1:1 Messages"],
  ["advanced", "Advanced"],
] as const)(
  "opens the Webex %s tab named by the subtab URL param on load",
  async (subtab, tabName) => {
    currentSearchParams = new URLSearchParams(`subtab=${subtab}`);
    render(<WebexSpaceRebacPanel />);

    expect(await screen.findByRole("tab", { name: tabName })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  },
);

it("writes the active Webex sub-tab to the subtab URL param when clicked", async () => {
  render(<WebexSpaceRebacPanel />);
  await screen.findByRole("tab", { name: "Configured spaces" });

  fireEvent.click(await screen.findByRole("tab", { name: "Configure spaces" }));
  expect(replaceMock).toHaveBeenLastCalledWith("/admin?subtab=onboard", {
    scroll: false,
  });

  fireEvent.click(screen.getByRole("tab", { name: "1:1 Messages" }));
  expect(replaceMock).toHaveBeenLastCalledWith("/admin?subtab=direct", {
    scroll: false,
  });

  fireEvent.click(screen.getByRole("tab", { name: "Configured spaces" }));
  expect(replaceMock).toHaveBeenLastCalledWith("/admin?subtab=channels", {
    scroll: false,
  });
});

// ── Discovery + onboarding ─────────────────────────────────────────────────

it("seeds configured Webex spaces on the onboard tab before discovery", async () => {
  render(<WebexSpaceRebacPanel />);
  fireEvent.click(await screen.findByRole("tab", { name: "Configure spaces" }));

  expect(await screen.findByText("Platform Alerts")).toBeInTheDocument();
  expect(screen.getByText("Configured by Platform Engineering")).toBeInTheDocument();
  expect(
    fetchMock.mock.calls.some(([url]) =>
      String(url).startsWith("/api/admin/webex/available-spaces"),
    ),
  ).toBe(false);
});

it("filters configured Webex spaces locally before live discovery runs", async () => {
  const baseFetch = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/admin/webex/spaces?health=1")) {
      return response({
        data: {
          spaces: [
            {
              workspace_id: "WEBEX-WORKSPACE",
              space_id: "space-abc",
              space_name: "Platform Alerts",
              team_slug: "platform-engineering",
              primary_agent_id: "incident-agent",
              active_grants: 1,
            },
            {
              workspace_id: "WEBEX-WORKSPACE",
              space_id: "space-caipe",
              space_name: "CAIPE Demo",
              team_slug: "platform-engineering",
              primary_agent_id: "incident-agent",
              active_grants: 1,
            },
          ],
        },
      });
    }
    return baseFetch?.(url, init) ?? response({});
  });

  render(<WebexSpaceRebacPanel />);
  fireEvent.click(await screen.findByRole("tab", { name: "Configure spaces" }));

  expect(await screen.findByText("Platform Alerts")).toBeInTheDocument();
  expect(screen.getByText("CAIPE Demo")).toBeInTheDocument();

  fireEvent.change(screen.getByRole("searchbox", { name: "Search spaces" }), {
    target: { value: "CAIPE" },
  });

  expect(screen.getByText("CAIPE Demo")).toBeInTheDocument();
  expect(screen.queryByText("Platform Alerts")).not.toBeInTheDocument();
  expect(
    fetchMock.mock.calls.some(([url]) =>
      String(url).startsWith("/api/admin/webex/available-spaces"),
    ),
  ).toBe(false);
});

it("deep-links and updates the configured Webex space search", async () => {
  currentSearchParams = new URLSearchParams(
    "subtab=channels&webexSpaceSearch=Platform",
  );
  const { rerender } = render(<WebexSpaceRebacPanel />);

  const searchInput = await screen.findByRole("textbox", {
    name: "Search configured spaces",
  });
  expect(searchInput).toHaveValue("Platform");
  expect(await screen.findByText("Platform Alerts")).toBeInTheDocument();

  fireEvent.change(searchInput, { target: { value: "nonexistent" } });
  expect(replaceMock).toHaveBeenLastCalledWith(
    "/admin?subtab=channels&webexSpaceSearch=nonexistent",
    { scroll: false },
  );

  currentSearchParams = new URLSearchParams(
    "subtab=channels&webexSpaceSearch=space-abc",
  );
  rerender(<WebexSpaceRebacPanel />);
  expect(searchInput).toHaveValue("space-abc");

  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(replaceMock).toHaveBeenLastCalledWith("/admin?subtab=channels", {
    scroll: false,
  });
});

it("discovers Webex bot spaces, auto-selects new ones, and submits verified onboarding", async () => {
  render(<WebexSpaceRebacPanel />);

  await clickFindSpaces();

  // Only the new space (Incident War Room) is auto-selected; existing one (Platform Alerts) is not
  expect(
    await screen.findByRole("status", {
      name: /Discovered: 2 .* Configured: 1/i,
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("checkbox", { name: /Import Incident War Room/i }),
  ).toBeChecked();
  expect(
    screen.getByRole("checkbox", { name: /Import Platform Alerts/i }),
  ).not.toBeChecked();
  await pickTeam("Team for Incident War Room", "platform-engineering");
  await pickAgent("Dynamic Agent for Incident War Room", "incident-agent");
  expect(screen.getByRole("combobox", { name: "Webex bot" })).toHaveTextContent("Primary bot");

  fireEvent.click(screen.getByRole("button", { name: /^Submit \d+ spaces?$/ }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/webex/spaces/onboard",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          bot_id: "primary",
          space_id: "space-new-123",
          space_name: "Incident War Room",
          team_slug: "platform-engineering",
          agent_id: "incident-agent",
          listen: "mention",
          create_route: true,
        }),
      }),
    ),
  );
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith(
      expect.stringContaining("Onboarded 1 Webex space"),
      "success",
    ),
  );
  expect(screen.queryByText("Ready to set up")).not.toBeInTheDocument();
  expect(screen.getAllByText(/^Configured/).length).toBeGreaterThan(0);
});

it("uses all-spaces bot defaults for new spaces and preserves saved overrides", async () => {
  const baseFetch = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/admin/webex/bots") {
      return response({
        data: {
          bots: [{
            id: "primary",
            name: "Primary bot",
            available: true,
            spaces: {
              accessMode: "all_spaces",
              defaultTeamSlug: "default-team",
              defaultAgentId: "default-agent",
            },
            directMessages: { accessMode: "allowlist", defaultAgentId: null },
          }],
        },
      });
    }
    if (url === "/api/dynamic-agents/teams") {
      return response({
        success: true,
        data: [
          { _id: "team-default", slug: "default-team", name: "Default Team" },
          { _id: "team-saved", slug: "saved-team", name: "Saved Team" },
        ],
      });
    }
    if (String(url).startsWith("/api/dynamic-agents?enabled_only=true")) {
      return response({
        data: {
          items: [
            { _id: "default-agent", name: "Default Agent" },
            { _id: "saved-agent", name: "Saved Agent" },
          ],
        },
      });
    }
    if (String(url).startsWith("/api/admin/webex/spaces?health=1")) {
      return response({
        data: {
          spaces: [{
            workspace_id: "WEBEX-WORKSPACE",
            space_id: "space-abc",
            space_name: "Saved Space",
            team_slug: "saved-team",
            primary_agent_id: "saved-agent",
            bot_id: "primary",
            active_grants: 1,
          }],
        },
      });
    }
    return baseFetch?.(url, init) ?? response({});
  });

  render(<WebexSpaceRebacPanel />);
  await clickFindSpaces();

  expect(await screen.findByLabelText("Team for Incident War Room")).toHaveTextContent("Default Team");
  expect(screen.getByLabelText("Dynamic Agent for Incident War Room")).toHaveTextContent("Default Agent");
  expect(screen.getByLabelText("Team for Platform Alerts")).toHaveTextContent("Saved Team");
  expect(screen.getByLabelText("Dynamic Agent for Platform Alerts")).toHaveTextContent("Saved Agent");
});

it("uses one top-level Webex bot selector for space discovery", async () => {
  render(<WebexSpaceRebacPanel />);

  await clickFindSpaces();
  await screen.findByRole("status", {
    name: /Discovered: 2 .* Configured: 1/i,
  });
  const botSelector = screen.getByRole("combobox", { name: "Webex bot" });
  expect(screen.queryByRole("combobox", { name: /Webex bot for / })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) =>
    new URL(String(url), "http://localhost").searchParams.get("bot_id") === "primary",
  )).toBe(true);

  fireEvent.click(botSelector);
  fireEvent.click(await screen.findByRole("option", { name: "Secondary bot" }));
  await clickFindSpaces();
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) =>
    new URL(String(url), "http://localhost").searchParams.get("bot_id") === "secondary",
  )).toBe(true));
});

it("forces a fresh Webex discovery when Refresh spaces is clicked", async () => {
  render(<WebexSpaceRebacPanel />);

  await clickFindSpaces();
  await screen.findByRole("button", { name: "Refresh spaces" });
  await clickRefreshSpaces();

  await waitFor(() => {
    const discoveryCalls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith("/api/admin/webex/available-spaces"));
    expect(discoveryCalls).toHaveLength(2);
    expect(new URL(discoveryCalls[0], "http://localhost").searchParams.has("refresh")).toBe(false);
    expect(new URL(discoveryCalls[1], "http://localhost").searchParams.get("refresh")).toBe("1");
  });
});

it("hides direct Webex rooms from space discovery", async () => {
  const baseFetch = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/admin/webex/available-spaces")) {
      return response({
        data: {
          spaces: [
            {
              id: "direct-room-123456",
              name: "Example User",
              type: "direct",
              is_locked: false,
              available_bot_ids: ["primary"],
            },
            {
              id: "space-new-123",
              name: "Incident War Room",
              type: "group",
              is_locked: false,
              available_bot_ids: ["primary"],
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      });
    }
    return baseFetch?.(url, init) ?? response({});
  });

  render(<WebexSpaceRebacPanel />);

  await clickFindSpaces();

  expect(
    await screen.findByRole("status", {
      name: /Discovered: 2 .* Configured: 1/i,
    }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Example User")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Submit 1 space" })).toBeEnabled();

  fireEvent.click(screen.getByRole("button", { name: "Submit 1 space" }));

  await waitFor(() => {
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === "/api/admin/webex/spaces/onboard" && init?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse(String(postCall?.[1]?.body ?? "{}"));
    expect(body).toEqual(expect.objectContaining({
      bot_id: "primary",
      space_id: "space-new-123",
      space_name: "Incident War Room",
      team_slug: "platform-engineering",
      agent_id: "incident-agent",
    }));
    expect(body).not.toHaveProperty("member_count");
  });
});

it("onboards deployment users independently for the bot selected above the table", async () => {
  render(<WebexSpaceRebacPanel />);

  fireEvent.click(await screen.findByRole("tab", { name: "1:1 Messages" }));
  expect(await screen.findByText("Example User")).toBeInTheDocument();
  expect(screen.getByText("not allowed")).toBeInTheDocument();
  const botSelector = screen.getByRole("combobox", { name: "Webex bot" });
  expect(botSelector).toHaveTextContent("Primary bot");
  expect(screen.queryByRole("combobox", { name: "Webex bot for user@example.com" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("checkbox", { name: "Allow direct messages for user@example.com" }));
  await pickAgent("Agent for user@example.com", "incident-agent");
  fireEvent.click(screen.getByRole("button", { name: "Save 1:1 access for user@example.com" }));

  await waitFor(() => {
    const putCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/admin/webex/direct-users" && init?.method === "PUT",
    );
    expect(putCall).toBeTruthy();
    expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({
      bot_id: "primary",
      keycloak_user_id: "user-1",
      agent_id: "incident-agent",
    });
  });

  fireEvent.click(botSelector);
  fireEvent.click(await screen.findByRole("option", { name: "Secondary bot" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => {
    const parsed = new URL(String(url), "http://localhost");
    return parsed.pathname === "/api/admin/webex/direct-users" &&
      parsed.searchParams.get("bot_id") === "secondary";
  })).toBe(true));
});

it("shows linked and unlinked Webex identity indicators", async () => {
  const baseFetch = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/admin/webex/direct-users") && !init?.method) {
      return response({
        data: {
          users: [
            {
              keycloak_user_id: "user-1",
              email: "user@example.com",
              display_name: "Example User",
              linked: false,
              enabled: false,
              configured: false,
              inherited: false,
              state: "not_allowed",
              agent_id: "",
            },
            {
              keycloak_user_id: "user-2",
              email: "linked-user@example.com",
              display_name: "Linked User",
              linked: true,
              enabled: false,
              configured: false,
              inherited: false,
              state: "not_allowed",
              agent_id: "",
            },
          ],
          bot_id: "primary",
          dm_access_mode: "allowlist",
          default_agent_id: null,
        },
      });
    }
    return baseFetch?.(url, init) ?? response({});
  });

  render(<WebexSpaceRebacPanel />);

  fireEvent.click(await screen.findByRole("tab", { name: "1:1 Messages" }));

  const linkedRow = (await screen.findByText("Linked User")).closest("tr") as HTMLElement;
  expect(within(linkedRow).getByText("Linked")).toBeInTheDocument();
  expect(within(linkedRow).queryByRole("link", { name: /Unlinked/i })).not.toBeInTheDocument();

  const unlinkedRow = screen.getByText("Example User").closest("tr") as HTMLElement;
  expect(within(unlinkedRow).getByRole("link", { name: "Unlinked" })).toHaveAttribute(
    "href",
    "/settings/account-and-access",
  );
});

it("shows inherited defaults and allows overrides in all-users mode", async () => {
  const baseFetch = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (
      String(url).startsWith("/api/admin/webex/direct-users") &&
      !init?.method
    ) {
      return response({
        data: {
          users: [
            {
              keycloak_user_id: "user-1",
              email: "user@example.com",
              display_name: "Example User",
              linked: false,
              enabled: true,
              configured: false,
              inherited: true,
              state: "inherited",
              agent_id: "fallback-agent",
            },
          ],
          bot_id: "primary",
          dm_access_mode: "all_users",
          default_agent_id: "fallback-agent",
        },
      });
    }
    return baseFetch?.(url, init) ?? response({});
  });

  render(<WebexSpaceRebacPanel />);

  fireEvent.click(await screen.findByRole("tab", { name: "1:1 Messages" }));

  expect(
    await screen.findByText(/All enabled deployment users can message this bot/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/configured default unless an admin saves an explicit override/i),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Bot default agent: fallback-agent"),
  ).toBeInTheDocument();
  expect(
    screen.getByLabelText("Allow direct messages for user@example.com"),
  ).toBeChecked();
  expect(screen.queryByRole("combobox", { name: "Team for user@example.com" })).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Agent for user@example.com" })).toHaveTextContent(
    "Fallback Agent",
  );
  expect(screen.getByText("inherited")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Save 1:1 access for user@example.com" }),
  ).toBeEnabled();
});

it("allows discovery before global defaults are configured", async () => {
  const baseFetch = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/admin/webex/spaces/defaults" && init?.method !== "POST") {
      return response({ data: { defaults: { team_slug: "", agent_id: "" } } });
    }
    return baseFetch?.(url, init) ?? response({});
  });

  render(<WebexSpaceRebacPanel />);

  await clickFindSpaces();

  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          String(url).startsWith("/api/admin/webex/available-spaces") &&
          String(url).includes("limit=200"),
      ),
    ).toBe(true),
  );
  expect(
    await screen.findByRole("status", {
      name: /Discovered: 2 .* Configured: 1/i,
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("checkbox", { name: /Import Incident War Room/i }),
  ).toBeChecked();
});

it("deletes a configured Webex space after confirmation", async () => {
  render(<WebexSpaceRebacPanel />);

  fireEvent.click(await screen.findByRole("tab", { name: "Configured spaces" }));
  fireEvent.click(await screen.findByText("Platform Alerts"));
  fireEvent.click(await screen.findByRole("button", { name: "Delete space Platform Alerts" }));

  expect(screen.getByRole("heading", { name: "Delete space from CAIPE?" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Delete space", exact: true }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/webex/spaces/WEBEX-WORKSPACE/space-abc?bot_id=primary",
      { method: "DELETE" },
    ),
  );
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith("Removed Platform Alerts from CAIPE.", "success"),
  );
});

it("shows an error toast and keeps the confirmation open when deleting a Webex space fails", async () => {
  const baseFetch = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (
      String(url).startsWith("/api/admin/webex/spaces/WEBEX-WORKSPACE/space-abc?") &&
      init?.method === "DELETE"
    ) {
      return response({ error: "boom" }, { ok: false, status: 500 });
    }
    return baseFetch?.(url, init) ?? response({});
  });

  render(<WebexSpaceRebacPanel />);

  fireEvent.click(await screen.findByRole("tab", { name: "Configured spaces" }));
  fireEvent.click(await screen.findByText("Platform Alerts"));
  fireEvent.click(await screen.findByRole("button", { name: "Delete space Platform Alerts" }));

  expect(screen.getByRole("heading", { name: "Delete space from CAIPE?" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Delete space", exact: true }));

  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith("Failed to delete Webex space: boom", "error"),
  );
  expect(screen.getByRole("heading", { name: "Delete space from CAIPE?" })).toBeInTheDocument();
  expect(screen.getByText("Platform Alerts")).toBeInTheDocument();
});

// ── Route editor (agent only — Mercury only ever delivers @mentions, so
// priority and listen mode are fixed rather than editable) ─────────────────

it("adds an agent to an empty Webex space via the route editor dialog", async () => {
  const baseFetch = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/admin/webex/spaces?health=1")) {
      return response({
        data: {
          spaces: [
            {
              workspace_id: "WEBEX-WORKSPACE",
              space_id: "space-empty",
              space_name: "Empty Space",
              bot_id: "primary",
              active_grants: 0,
            },
          ],
        },
      });
    }
    if (String(url).includes("/space-empty/routes?")) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body ?? "{}"));
        return response({ data: { routes: body.routes } });
      }
      return response({ data: { routes: [] } });
    }
    if (String(url).includes("/space-empty/diagnostics?")) {
      return response({
        data: { openfga: { reachable: true, tuple_count: 0 }, warnings: [], routes: [] },
      });
    }
    return baseFetch?.(url, init) ?? response({});
  });

  render(<WebexSpaceRebacPanel />);
  fireEvent.click(await screen.findByRole("tab", { name: "Configured spaces" }));
  fireEvent.click(await screen.findByText("Empty Space"));

  expect(await screen.findByText("No agent responds in Empty Space yet.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add Agent" }));

  expect(screen.getByRole("dialog", { name: "Add Agent to Empty Space" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Priority")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Listen" })).not.toBeInTheDocument();
  await pickAgent("Dynamic Agent", "incident-agent");
  fireEvent.click(screen.getByRole("button", { name: "Add Agent" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/webex/spaces/WEBEX-WORKSPACE/space-empty/routes?bot_id=primary",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          routes: [{
            agent_id: "incident-agent",
            enabled: true,
            priority: 100,
            users: { enabled: true, listen: "mention" },
          }],
        }),
      }),
    ),
  );
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith("Webex space agent added.", "success"),
  );
});

it("edits an existing Webex space route's agent, keeping priority and listen mode fixed", async () => {
  render(<WebexSpaceRebacPanel />);

  fireEvent.click(await screen.findByRole("tab", { name: "Configured spaces" }));
  fireEvent.click(await screen.findByText("Platform Alerts"));
  fireEvent.click(await screen.findByRole("button", { name: "Edit agent:incident-agent" }));

  const editor = screen.getByRole("dialog", { name: "Edit agent:incident-agent" });
  expect(within(editor).queryByLabelText("Priority")).not.toBeInTheDocument();
  expect(within(editor).queryByRole("button", { name: "Listen" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Update Agent" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/webex/spaces/WEBEX-WORKSPACE/space-abc/routes?bot_id=primary",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          routes: [{
            agent_id: "incident-agent",
            enabled: true,
            priority: 100,
            users: { enabled: true, listen: "mention" },
          }],
        }),
      }),
    ),
  );
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith("Webex space agent updated.", "success"),
  );
});

it("shows an error toast and keeps the dialog open when saving a Webex space route fails", async () => {
  const baseFetch = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/routes?") && init?.method === "PUT") {
      return response({ error: "boom" }, { ok: false, status: 500 });
    }
    return baseFetch?.(url, init) ?? response({});
  });

  render(<WebexSpaceRebacPanel />);

  fireEvent.click(await screen.findByRole("tab", { name: "Configured spaces" }));
  fireEvent.click(await screen.findByText("Platform Alerts"));
  fireEvent.click(await screen.findByRole("button", { name: "Edit agent:incident-agent" }));

  const editor = screen.getByRole("dialog", { name: "Edit agent:incident-agent" });
  fireEvent.click(within(editor).getByRole("button", { name: "Update Agent" }));

  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith("Failed to save Webex space agent: boom", "error"),
  );
  expect(screen.getByRole("dialog", { name: "Edit agent:incident-agent" })).toBeInTheDocument();
});

it("deletes a route agent from a configured Webex space after confirmation", async () => {
  render(<WebexSpaceRebacPanel />);

  fireEvent.click(await screen.findByRole("tab", { name: "Configured spaces" }));
  fireEvent.click(await screen.findByText("Platform Alerts"));
  fireEvent.click(await screen.findByRole("button", { name: "Delete agent:incident-agent" }));

  expect(screen.getByRole("heading", { name: "Remove agent from space?" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove agent" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/webex/spaces/WEBEX-WORKSPACE/space-abc/routes?bot_id=primary",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ agent_id: "incident-agent" }),
      }),
    ),
  );
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith("Webex space agent removed.", "success"),
  );
});

it("no longer offers a routing fix for a route that only differs by listen mode", async () => {
  render(<WebexSpaceRebacPanel />);

  fireEvent.click(await screen.findByRole("tab", { name: "Configured spaces" }));
  fireEvent.click(await screen.findByText("Platform Alerts"));

  // foo-bar: stale route metadata with no OpenFGA tuple — still a real,
  // fixable orphan.
  expect(
    await screen.findByRole("button", { name: "Fix routing for foo-bar" }),
  ).toBeInTheDocument();
  // incident-agent: has its OpenFGA tuple and only differs by listen mode
  // ("mention" vs "all") — that is an intentional choice now, not a bug.
  expect(
    screen.queryByRole("button", { name: "Fix routing for incident-agent" }),
  ).not.toBeInTheDocument();
});
