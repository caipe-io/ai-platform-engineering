import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const mockToast = jest.fn();
jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

const replaceMock = jest.fn();
let currentSearchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  usePathname: () => "/admin/integrations/slack",
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => currentSearchParams,
}));

import { SlackChannelRebacPanel } from "../SlackChannelRebacPanel";
import { pickTeam } from "@/__test-utils__/team-picker";
import { pickAgent } from "@/__test-utils__/agent-picker";

const fetchMock = jest.fn();

beforeEach(() => {
  mockToast.mockClear();
  replaceMock.mockReset();
  currentSearchParams = new URLSearchParams();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (
      url === "/api/admin/slack/channels" ||
      url === "/api/admin/slack/channels?health=1"
    ) {
      return response({
        data: {
          channels: [
            {
              workspace_id: "T123456789",
              channel_id: "C123456789",
              channel_name: "incidents",
              team_slug: "platform-engineering",
              primary_agent_id: "incident-agent",
              active_grants: 1,
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
          ],
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
          { _id: "team-2", slug: "security", name: "Security" },
        ],
      });
    }
    if (
      url === "/api/admin/slack/channels/defaults" &&
      init?.method === "POST"
    ) {
      return response({
        data: {
          summary: {
            channels_seen: 1,
            channels_assigned_team: 1,
            channel_grants_ensured: 1,
            routes_ensured: 1,
          },
        },
      });
    }
    if (url === "/api/admin/slack/channels/defaults") {
      return response({
        data: {
          defaults: {
            team_slug: "platform-engineering",
            agent_id: "incident-agent",
          },
        },
      });
    }
    if (url === "/api/admin/slack/runtime/status") {
      return response({
        data: {
          route_mode: "db_prefer",
          static_config: { channels: 1, routes: 1 },
          route_cache: {
            ttl_seconds: 60,
            cache_size: 1,
            cached_channels: ["CAIPE/C123456789"],
          },
          last_sync: null,
        },
      });
    }
    if (url === "/api/admin/slack/runtime/config-defaults") {
      return response({
        data: {
          workspace_id: "T123456789",
          channels_seen: 2,
          routes_seen: 2,
          channels: {
            C123456789: {
              workspace_id: "T123456789",
              channel_id: "C123456789",
              channel_name: "#incidents",
              agents: [{ agent_id: "incident-agent", priority: 100 }],
              suggested_agent_id: "incident-agent",
            },
            CNEWMISSING: {
              workspace_id: "T123456789",
              channel_id: "CNEWMISSING",
              channel_name: "#new-alerts",
              agents: [{ agent_id: "test-april-2025", priority: 100 }],
              suggested_agent_id: "test-april-2025",
            },
          },
        },
      });
    }
    if (url === "/api/admin/slack/runtime/reload") {
      return response({ data: { reloaded: "all" } });
    }
    if (url === "/api/admin/slack/runtime/sync-from-config") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return response({
        data: {
          dry_run: Boolean(body.dry_run),
          channels_seen: 1,
          routes_planned: 1,
          routes_upserted: body.dry_run ? 0 : 1,
          openfga_tuples_written: body.dry_run ? 0 : 1,
        },
      });
    }
    if (url.startsWith("/api/admin/slack/available-channels")) {
      return response({
        data: {
          channels: [
            {
              id: "C123456789",
              name: "incidents",
              is_private: false,
              is_member: true,
              num_members: 10,
              configured: true,
              configured_team_slug: "platform-engineering",
              configured_team_name: "Platform Engineering",
            },
            {
              id: "CNEWMISSING",
              name: "new-alerts",
              is_private: false,
              is_member: true,
              num_members: 7,
            },
          ],
          total_matches: 2,
          total_visible: 2,
          next_cursor: null,
          has_more: false,
          cached: false,
          fetched_at: Date.now(),
          query: { q: "", member_only: true, limit: 500 },
        },
      });
    }
    if (url.endsWith("/resources") && init?.method === "PUT") {
      return response({
        data: {
          grants: [
            {
              resource: { type: "agent", id: "test-april-2025" },
              actions: ["use"],
              status: "active",
            },
          ],
        },
      });
    }
    if (url.endsWith("/resources")) {
      return response({ data: { grants: [] } });
    }
    if (url.endsWith("/routes") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body ?? "{}"));
      return response({ data: { routes: body.routes } });
    }
    if (url.endsWith("/routes") && init?.method === "DELETE") {
      return response({
        data: {
          deleted: { agent_id: "incident-agent", route_metadata_deleted: true },
          openfga: { enabled: true, writes: 0, deletes: 1 },
        },
      });
    }
    if (url.endsWith("/routes")) {
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
    if (url.endsWith("/diagnostics")) {
      return response({
        data: {
          openfga: { reachable: true, tuple_count: 1 },
          warnings: [
            "agent:foo-bar has Mongo route metadata, but the OpenFGA tuple is missing; runtime ignores it.",
            "Route agent:incident-agent only listens to mentions. Plain channel messages will be ignored.",
          ],
          routes: [
            {
              agent_id: "foo-bar",
              openfga_tuple: false,
              route_metadata: true,
              listen: "message",
              runtime_matches: { mention: false, message: true },
              warnings: ["OpenFGA tuple is missing."],
            },
            {
              agent_id: "incident-agent",
              openfga_tuple: true,
              route_metadata: true,
              listen: "mention",
              runtime_matches: { mention: true, message: false },
              warnings: ["Plain channel messages will be ignored."],
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
    return response({});
  });
});

afterEach(() => {
  jest.useRealTimers();
});

function response(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

it("scopes the configured channel list to the simulated user", async () => {
  render(
    <SlackChannelRebacPanel
      selfService
      disabled
      simulationTarget={{ type: "user", id: "target-sub" }}
    />,
  );

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/slack/channels?simulate_type=user&simulate_id=target-sub&health=1",
    );
  });
});

it("fetches runtime status on mount since Slack's Advanced tab is not minimal", async () => {
  render(<SlackChannelRebacPanel />);

  await waitFor(() => {
    expect(
      fetchMock.mock.calls.some(([url]) => url === "/api/admin/slack/runtime/status"),
    ).toBe(true);
  });
});

it("shows a loading spinner while self-service channels load", async () => {
  let resolveChannels: ((value: Response) => void) | undefined;
  const channelsPromise = new Promise<Response>((resolve) => {
    resolveChannels = resolve;
  });
  fetchMock.mockImplementation(async (url: string) => {
    if (
      url === "/api/admin/slack/channels" ||
      url === "/api/admin/slack/channels?health=1"
    ) {
      return channelsPromise;
    }
    if (url.startsWith("/api/dynamic-agents?enabled_only=true")) {
      return response({ data: { items: [] } });
    }
    return response({});
  });

  render(<SlackChannelRebacPanel selfService />);
  expect(screen.getByTestId("connector-items-loading")).toBeInTheDocument();
  expect(screen.getByText("Loading Slack channels…")).toBeInTheDocument();
  expect(
    screen.queryByText("No channels shared with your team yet."),
  ).not.toBeInTheDocument();

  resolveChannels?.(
    response({
      data: { channels: [] },
    }),
  );
  expect(
    await screen.findByText("No channels shared with your team yet."),
  ).toBeInTheDocument();
  expect(
    screen.queryByTestId("connector-items-loading"),
  ).not.toBeInTheDocument();
});

it("shows channels configured by another team without allowing duplicate onboarding", async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (
      url === "/api/admin/slack/channels" ||
      url === "/api/admin/slack/channels?health=1"
    ) {
      return response({ data: { channels: [] } });
    }
    if (url.startsWith("/api/dynamic-agents?enabled_only=true")) {
      return response({ data: { items: [] } });
    }
    if (url === "/api/dynamic-agents/teams") {
      return response({
        success: true,
        data: [{ _id: "team-1", slug: "primary", name: "Primary" }],
      });
    }
    if (url === "/api/admin/slack/channels/defaults") {
      return response({ data: { defaults: {} } });
    }
    if (url.startsWith("/api/admin/slack/available-channels")) {
      return response({
        data: {
          channels: [
            {
              id: "CALREADY",
              name: "already-set-up",
              is_member: true,
              num_members: 20,
              configured: true,
              configured_team_slug: "super-admins",
              configured_team_name: "Super Admins",
              configured_agent_id: "saved-agent",
              configured_agent_name: "Saved Agent",
            },
          ],
          total_matches: 1,
          total_visible: 1,
          next_cursor: null,
          has_more: false,
        },
      });
    }
    return response({});
  });

  render(<SlackChannelRebacPanel selfService />);
  await switchToTab("Onboard channels");
  expect(
    screen.queryByRole("region", {
      name: "Apply team and agent to selected rows",
    }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Find channels" }));

  expect(
    await screen.findByText("Configured by Super Admins"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("checkbox", { name: "Import #already-set-up" }),
  ).toBeDisabled();
  expect(screen.getByLabelText("Team for #already-set-up")).toBeDisabled();
  expect(screen.getByLabelText("Team for #already-set-up")).toHaveTextContent(
    "Super Admins",
  );
  expect(
    screen.getByLabelText("Dynamic Agent for #already-set-up"),
  ).toBeDisabled();
  expect(
    screen.getByLabelText("Dynamic Agent for #already-set-up"),
  ).toHaveTextContent("Saved Agent");
  expect(screen.queryByText("Direct user routing")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Select all" })).toBeDisabled();
});

it("shows discovery loading while Find channels scans Slack", async () => {
  let resolveDiscovery: ((value: Response) => void) | undefined;
  const discoveryPromise = new Promise<Response>((resolve) => {
    resolveDiscovery = resolve;
  });
  fetchMock.mockImplementation(async (url: string) => {
    if (
      url === "/api/admin/slack/channels" ||
      url === "/api/admin/slack/channels?health=1"
    ) {
      return response({ data: { channels: [] } });
    }
    if (url.startsWith("/api/admin/slack/available-channels")) {
      return discoveryPromise;
    }
    if (url.startsWith("/api/dynamic-agents?enabled_only=true")) {
      return response({
        data: { items: [{ _id: "incident-agent", name: "Incident Agent" }] },
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
    if (url === "/api/admin/slack/channels/defaults") {
      return response({ data: { defaults: { team_slug: "", agent_id: "" } } });
    }
    return response({});
  });

  render(<SlackChannelRebacPanel />);
  await switchToTab("Onboard channels");
  fireEvent.click(screen.getByRole("button", { name: "Find channels" }));

  expect(await screen.findByTestId("discovery-loading")).toBeInTheDocument();
  expect(screen.getByTestId("discovery-loading")).toHaveTextContent(
    "Finding channels…",
  );

  resolveDiscovery?.(
    response({
      data: {
        channels: [
          {
            id: "CNEWMISSING",
            name: "new-alerts",
            is_private: false,
            is_member: true,
            num_members: 7,
          },
        ],
        total_matches: 1,
        total_visible: 1,
        next_cursor: null,
        has_more: false,
        cached: true,
        fetched_at: Date.now(),
        query: { q: "", member_only: true, limit: 500 },
      },
    }),
  );
  await waitFor(() =>
    expect(screen.queryByTestId("discovery-loading")).not.toBeInTheDocument(),
  );
  expect(
    await screen.findByRole("status", { name: /Discovered: 1/i }),
  ).toBeInTheDocument();
});

async function switchToTab(
  name: "Configured channels" | "Onboard channels" | "Advanced",
) {
  const tab = await screen.findByRole("tab", { name });
  fireEvent.click(tab);
}

/**
 * Configured-channels are now a table that collapses by default; the
 * detail panel (diagnostics + agents form) renders inline only after
 * the row is expanded. Tests that interact with the detail panel must
 * expand the row first.
 */
async function expandChannelRow(channelName: string): Promise<void> {
  const row = (await screen.findByText(`#${channelName}`)).closest("tr");
  if (!row)
    throw new Error(`expandChannelRow: row for #${channelName} not found`);
  fireEvent.click(row);
}

it("uses enabled Dynamic Agents dropdown for Slack channel-agent associations", async () => {
  render(<SlackChannelRebacPanel />);

  // Configured channels appears twice on screen — as the CardTitle and as
  // the active tab button. Targeting the tab unambiguously also doubles
  // as a smoke test that the tab structure rendered.
  expect(
    await screen.findByRole("tab", { name: "Configured channels" }),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("Resource Type")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Action")).not.toBeInTheDocument();

  await expandChannelRow("incidents");
  fireEvent.click(await screen.findByRole("button", { name: "Add Agent" }));
  // The route-agent AgentPicker lives in the focused agent editor.
  expect(await screen.findByLabelText("Dynamic Agent")).toBeInTheDocument();

  await pickAgent("Dynamic Agent", "test-april-2025");
  fireEvent.click(screen.getByRole("button", { name: "Add Agent" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/slack/channels/T123456789/C123456789/routes",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"agent_id":"test-april-2025"'),
      }),
    ),
  );
});

it("preserves imported escalation/overthink/bots when editing a route (no data loss)", async () => {
  // A route imported from YAML carries bots + overthink + escalation. The
  // old editor only sent users.listen + priority, so saving silently
  // stripped the rest. This pins the full round-trip.
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (
      url === "/api/admin/slack/channels" ||
      url === "/api/admin/slack/channels?health=1"
    ) {
      return response({
        data: {
          channels: [
            {
              workspace_id: "T123456789",
              channel_id: "C123456789",
              channel_name: "incidents",
              active_grants: 1,
            },
          ],
        },
      });
    }
    if (url.startsWith("/api/dynamic-agents?enabled_only=true")) {
      return response({
        data: { items: [{ _id: "incident-agent", name: "Incident Agent" }] },
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
    if (url === "/api/admin/slack/channels/defaults") {
      return response({
        data: {
          defaults: {
            team_slug: "platform-engineering",
            agent_id: "incident-agent",
          },
        },
      });
    }
    if (url === "/api/admin/slack/runtime/status") {
      return response({
        data: {
          route_mode: "db_prefer",
          static_config: { channels: 1, routes: 1 },
          route_cache: { ttl_seconds: 60, cache_size: 1, cached_channels: [] },
          last_sync: null,
        },
      });
    }
    if (url.endsWith("/routes") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body ?? "{}"));
      return response({ data: { routes: body.routes } });
    }
    if (url.endsWith("/routes")) {
      return response({
        data: {
          routes: [
            {
              agent_id: "incident-agent",
              enabled: true,
              priority: 100,
              users: {
                enabled: true,
                listen: "all",
                user_list: ["U1"],
                overthink: { enabled: true, skip_markers: ["DEFER"] },
              },
              bots: {
                enabled: true,
                listen: "message",
                bot_list: ["AlertBot"],
              },
              escalation: {
                victorops: { enabled: true, team: "dao" },
                emoji: { enabled: true, name: "rotating_light" },
                users: ["U027"],
              },
            },
          ],
        },
      });
    }
    if (url.endsWith("/diagnostics")) {
      return response({
        data: {
          openfga: { reachable: true, tuple_count: 1 },
          warnings: [],
          routes: [],
          last_runtime_error: null,
        },
      });
    }
    if (url.endsWith("/resources")) {
      return response({ data: { grants: [] } });
    }
    return response({});
  });

  render(<SlackChannelRebacPanel />);
  await expandChannelRow("incidents");

  // The list row surfaces the rich config as badges.
  expect(await screen.findByText("bots:message")).toBeInTheDocument();
  expect(screen.getByText("escalation")).toBeInTheDocument();

  fireEvent.click(
    await screen.findByRole("button", { name: /edit agent:incident-agent/i }),
  );
  // Tweak only the priority; everything else must survive untouched.
  const editor = screen.getByRole("dialog", {
    name: /edit agent:incident-agent/i,
  });
  fireEvent.change(within(editor).getByLabelText("Priority"), {
    target: { value: "50" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Update Agent" }));

  await waitFor(() => {
    const putCall = fetchMock.mock.calls.find(
      ([u, i]) =>
        String(u).endsWith("/routes") &&
        (i as RequestInit | undefined)?.method === "PUT",
    );
    expect(putCall).toBeTruthy();
    const body = JSON.parse(String((putCall![1] as RequestInit).body));
    const saved = body.routes.find(
      (r: { agent_id: string }) => r.agent_id === "incident-agent",
    );
    expect(saved.priority).toBe(50);
    expect(saved.users.listen).toBe("all");
    expect(saved.users.user_list).toEqual(["U1"]);
    expect(saved.users.overthink.enabled).toBe(true);
    expect(saved.users.overthink.skip_markers).toEqual(["DEFER"]);
    expect(saved.bots.listen).toBe("message");
    expect(saved.bots.bot_list).toEqual(["AlertBot"]);
    expect(saved.escalation.victorops).toEqual({ enabled: true, team: "dao" });
    expect(saved.escalation.emoji).toEqual({
      enabled: true,
      name: "rotating_light",
    });
    expect(saved.escalation.users).toEqual(["U027"]);
  });
});

it("renders the full per-channel/agent breakdown in the sync preview modal", async () => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (
      url === "/api/admin/slack/channels" ||
      url === "/api/admin/slack/channels?health=1"
    ) {
      return response({ data: { channels: [] } });
    }
    if (url.startsWith("/api/dynamic-agents?enabled_only=true")) {
      return response({ data: { items: [] } });
    }
    if (url === "/api/dynamic-agents/teams") {
      return response({ success: true, data: [] });
    }
    if (url === "/api/admin/slack/channels/defaults") {
      return response({ data: { defaults: {} } });
    }
    if (url === "/api/admin/slack/runtime/status") {
      return response({
        data: {
          route_mode: "db_prefer",
          static_config: { channels: 2, routes: 2 },
          route_cache: { ttl_seconds: 60, cache_size: 0, cached_channels: [] },
          last_sync: null,
        },
      });
    }
    if (url === "/api/admin/slack/runtime/sync-from-config") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return response({
        data: {
          dry_run: Boolean(body.dry_run),
          channels_seen: 2,
          routes_planned: 2,
          routes_upserted: 0,
          openfga_tuples_written: 0,
          channels: [
            {
              workspace_id: "CAIPE",
              channel_id: "C0B07SE98TH",
              channel_name: "#forge-beta",
              team_slug: "platform-engineering",
              has_team: true,
              agents: [
                {
                  agent_id: "default",
                  priority: 100,
                  users: { enabled: true, listen: "mention" },
                  escalation: {
                    victorops: { enabled: true, team: "dao" },
                    emoji: { enabled: true, name: "ai-for-brains" },
                  },
                },
              ],
            },
            {
              workspace_id: "CAIPE",
              channel_id: "C05GVCQ8J9K",
              channel_name: "#ciplat-dev",
              team_slug: null,
              has_team: false,
              agents: [
                {
                  agent_id: "agent-huyn-test-agent",
                  priority: 100,
                  users: {
                    enabled: true,
                    listen: "mention",
                    overthink: { enabled: true },
                  },
                },
              ],
            },
          ],
        },
      });
    }
    return response({});
  });

  render(<SlackChannelRebacPanel />);
  await switchToTab("Advanced");

  fireEvent.click(
    await screen.findByRole("button", { name: "Import from YAML" }),
  );

  expect(
    await screen.findByText("Slack Bot Config Sync Preview"),
  ).toBeInTheDocument();
  // Channel + team rendering.
  expect(await screen.findByText("#forge-beta")).toBeInTheDocument();
  expect(screen.getByText("team:platform-engineering")).toBeInTheDocument();
  // The teamless channel is flagged so the admin knows it won't be invokable.
  expect(screen.getByText("#ciplat-dev")).toBeInTheDocument();
  expect(screen.getAllByText("no team").length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText(/without a team/i)).toBeInTheDocument();
  // Per-agent detail (escalation summary + overthink) is visible.
  expect(screen.getByText("agent:default")).toBeInTheDocument();
  expect(screen.getByText(/VictorOps \(dao\)/)).toBeInTheDocument();
  expect(screen.getByText("agent:agent-huyn-test-agent")).toBeInTheDocument();
});

it("does not show legacy grant counts in the configured channels table", async () => {
  render(<SlackChannelRebacPanel />);

  // Channel rows live in the Configured Channels table now (replaced
  // the prior <select> dropdown).
  expect(await screen.findByText("#incidents")).toBeInTheDocument();
  expect(screen.queryByText(/0 grants/i)).not.toBeInTheDocument();
});

it("shows configured team and primary agent in the configured channels table", async () => {
  render(<SlackChannelRebacPanel />);

  expect(await screen.findByText("#incidents")).toBeInTheDocument();
  expect(screen.getByText("team:platform-engineering")).toBeInTheDocument();
  expect(screen.getByText("Incident Agent")).toBeInTheDocument();
  expect(screen.getByText("incident-agent")).toBeInTheDocument();
});

it("fixes stale Slack runtime diagnostics by deleting orphaned route metadata", async () => {
  render(<SlackChannelRebacPanel />);
  await expandChannelRow("incidents");

  fireEvent.click(
    await screen.findByRole("button", { name: /Fix routing for foo-bar/i }),
  );

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/slack/channels/T123456789/C123456789/routes",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ agent_id: "foo-bar" }),
      }),
    ),
  );
});

it("surfaces Slack runtime diagnostics warnings", async () => {
  render(<SlackChannelRebacPanel />);
  await expandChannelRow("incidents");

  expect(
    await screen.findByText(/Plain channel messages will be ignored/i),
  ).toBeInTheDocument();
  expect(screen.getByText(/OpenFGA tuple read failed/i)).toBeInTheDocument();
});

it("edits and deletes Slack channel-agent associations with metadata warning", async () => {
  const confirmSpy = jest.spyOn(window, "confirm");
  render(<SlackChannelRebacPanel />);
  await expandChannelRow("incidents");

  expect(
    await screen.findByRole("button", { name: /edit agent:incident-agent/i }),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: /edit agent:incident-agent/i }),
  );
  const editor = screen.getByRole("dialog", {
    name: /edit agent:incident-agent/i,
  });
  fireEvent.change(within(editor).getByLabelText("Listen"), {
    target: { value: "message" },
  });
  fireEvent.change(within(editor).getByLabelText("Priority"), {
    target: { value: "25" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Update Agent" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/slack/channels/T123456789/C123456789/routes",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"priority":25'),
      }),
    ),
  );
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/admin/slack/channels/T123456789/C123456789/routes",
    expect.objectContaining({
      method: "PUT",
      body: expect.stringContaining('"listen":"message"'),
    }),
  );

  // saveRoute leaves loading=true until its loadChannels/loadDiagnostics
  // chain settles; clicking Delete while disabled is a silent no-op,
  // which is what stalled this test before. Wait for the button to
  // reactivate first.
  const deleteButton = await screen.findByRole("button", {
    name: /delete agent:incident-agent/i,
  });
  await waitFor(() => expect(deleteButton).not.toBeDisabled());
  fireEvent.click(deleteButton);
  expect(confirmSpy).not.toHaveBeenCalled();
  expect(
    await screen.findByRole("dialog", { name: "Remove agent from channel?" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      /removes agent:incident-agent from the selected Slack channel/i,
    ),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove agent" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/slack/channels/T123456789/C123456789/routes",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ agent_id: "incident-agent" }),
      }),
    ),
  );
});

it("keeps Slack onboarding intentional without saved defaults or bulk apply controls", async () => {
  render(<SlackChannelRebacPanel />);
  await switchToTab("Onboard channels");

  expect(
    screen.queryByText("Default team and agent for new channels"),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Preselected Team")).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Preselected Dynamic Agent"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", {
      name: "Apply Selection to Managed Channels",
    }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Refresh lists" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Create matching Slack routes when onboarding/i),
  ).not.toBeInTheDocument();
});

it("discovers bot-member channels and applies defaults after admin consent", async () => {
  render(<SlackChannelRebacPanel />);
  await switchToTab("Onboard channels");

  fireEvent.click(screen.getByRole("button", { name: "Find channels" }));

  expect(
    await screen.findByRole("status", {
      name: /Discovered: 2 .* Configured: 1 .* New: 1/i,
    }),
  ).toBeInTheDocument();
  // Discovery no longer auto-selects rows.
  expect(
    screen.getByRole("checkbox", { name: /Import #incidents/i }),
  ).toBeDisabled();
  expect(
    screen.getByRole("checkbox", { name: /Import #new-alerts/i }),
  ).not.toBeChecked();
  expect(
    screen.getByRole("button", { name: "Refresh channels" }),
  ).toBeInTheDocument();

  // Existing channels stay visible but cannot be onboarded again.
  expect(screen.getByText("Configured by Platform Engineering")).toBeInTheDocument();
  expect(screen.getByLabelText("Team for #incidents")).toBeDisabled();
  expect(screen.getByLabelText("Team for #incidents")).toHaveTextContent(
    "Platform Engineering",
  );
  expect(screen.getByLabelText("Dynamic Agent for #incidents")).toBeDisabled();
  expect(screen.getByLabelText("Dynamic Agent for #incidents")).toHaveTextContent(
    "Incident Agent",
  );

  // Admin opts in to the new row and chooses its team and agent.
  fireEvent.click(
    screen.getByRole("checkbox", { name: /Import #new-alerts/i }),
  );
  await pickTeam("Team for #new-alerts", "security");
  await pickAgent("Dynamic Agent for #new-alerts", "test-april-2025");
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: /^Submit 1 channel$/ }),
    ).toBeEnabled();
  });

  fireEvent.click(
    screen.getByRole("button", { name: /^Submit \d+ channels?$/ }),
  );

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/slack/available-channels?"),
      expect.anything(),
    ),
  );
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/slack/channels/defaults",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"channel_defaults"'),
      }),
    ),
  );
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/admin/slack/channels/defaults",
    expect.objectContaining({
      body: expect.stringContaining('"id":"CNEWMISSING"'),
    }),
  );
  const onboardingBody = String(
    fetchMock.mock.calls.find(
      ([url, init]) =>
        url === "/api/admin/slack/channels/defaults" && init?.method === "POST",
    )?.[1]?.body ?? "",
  );
  expect(onboardingBody).not.toContain("C123456789");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/admin/slack/channels/defaults",
    expect.objectContaining({
      body: expect.stringContaining('"team_slug":"security"'),
    }),
  );
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/admin/slack/channels/defaults",
    expect.objectContaining({
      body: expect.stringContaining('"agent_id":"test-april-2025"'),
    }),
  );
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith(
      expect.stringContaining("Discovered defaults applied"),
      "success",
    ),
  );
});

it("discovers Slack channels even when no onboarding default team is configured", async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (
      url === "/api/admin/slack/channels" ||
      url === "/api/admin/slack/channels?health=1"
    ) {
      return response({ data: { channels: [] } });
    }
    if (url.startsWith("/api/dynamic-agents?enabled_only=true")) {
      return response({
        data: {
          items: [{ _id: "incident-agent", name: "Incident Agent" }],
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
    if (url === "/api/admin/slack/channels/defaults") {
      return response({ data: { defaults: {} } });
    }
    if (url === "/api/admin/slack/runtime/status") {
      return response({
        data: {
          route_mode: "db_prefer",
          static_config: { channels: 0, routes: 0 },
          route_cache: { ttl_seconds: 60, cache_size: 0, cached_channels: [] },
          last_sync: null,
        },
      });
    }
    if (url === "/api/admin/slack/runtime/config-defaults") {
      return response({
        data: {
          workspace_id: "T123456789",
          channels_seen: 0,
          routes_seen: 0,
          channels: {},
        },
      });
    }
    if (url.startsWith("/api/admin/slack/available-channels")) {
      return response({
        data: {
          channels: [
            {
              id: "CNEWMISSING",
              name: "new-alerts",
              is_private: false,
              is_member: true,
              num_members: 7,
            },
          ],
          next_cursor: null,
          has_more: false,
        },
      });
    }
    if (url.endsWith("/resources")) {
      return response({ data: { grants: [] } });
    }
    if (url.endsWith("/routes")) {
      return response({ data: { routes: [] } });
    }
    if (url.endsWith("/diagnostics")) {
      return response({
        data: {
          openfga: { reachable: true, tuple_count: 0 },
          warnings: [],
          routes: [],
          last_runtime_error: null,
        },
      });
    }
    return response({});
  });

  render(<SlackChannelRebacPanel />);
  await switchToTab("Onboard channels");

  const discoverButton = await screen.findByRole("button", {
    name: "Find channels",
  });
  await waitFor(() => expect(discoverButton).not.toBeDisabled());
  fireEvent.click(discoverButton);

  expect(
    await screen.findByRole("status", { name: /Discovered: 1/i }),
  ).toBeInTheDocument();
});

it("shows discovered channel setup feedback as a toast without shifting the action row", async () => {
  render(<SlackChannelRebacPanel />);
  await switchToTab("Onboard channels");

  fireEvent.click(screen.getByRole("button", { name: "Find channels" }));

  expect(
    await screen.findByRole("status", { name: /Discovered: 2/i }),
  ).toBeInTheDocument();
  // Discovery no longer auto-selects rows — opt in to the new channel.
  fireEvent.click(
    screen.getByRole("checkbox", { name: /Import #new-alerts/i }),
  );
  await pickTeam("Team for #new-alerts", "security");
  await pickAgent("Dynamic Agent for #new-alerts", "test-april-2025");

  const applyButton = screen.getByRole("button", {
    name: /^Submit \d+ channels?$/,
  });
  fireEvent.click(applyButton);

  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith(
      expect.stringContaining("Discovered defaults applied"),
      "success",
    ),
  );
  expect(
    screen.queryByRole("dialog", { name: "Slack setup complete" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  expect(screen.queryByText("Ready to set up")).not.toBeInTheDocument();
  expect(screen.getAllByText(/^Configured/).length).toBeGreaterThanOrEqual(2);
  expect(applyButton.parentElement).not.toHaveTextContent(
    /Channel setup applied/i,
  );
});

it("uses a streamlined setup flow with icons and toast action confirmations", async () => {
  render(<SlackChannelRebacPanel />);

  // Channels view (default) shows the configured-channels table; the
  // diagnostics + agents detail panel collapses inline when a row is
  // expanded.
  expect(
    await screen.findByRole("tab", { name: "Configured channels" }),
  ).toBeInTheDocument();
  expect(await screen.findByText("#incidents")).toBeInTheDocument();
  await expandChannelRow("incidents");
  // The detail panel adds Diagnostics + Agents section labels alongside
  // the existing "Agents" table header — assert the buttons that only
  // appear inside the detail panel to disambiguate.
  expect(await screen.findByText("Diagnostics")).toBeInTheDocument();
  expect(
    await screen.findByRole("button", { name: "Add Agent" }),
  ).toBeInTheDocument();

  // Onboard view shows only the discovery wizard.
  await switchToTab("Onboard channels");
  expect(
    screen.getByRole("button", { name: "Find channels" }),
  ).toBeInTheDocument();

  // Advanced view exposes runtime status + YAML import controls.
  await switchToTab("Advanced");
  expect(
    await screen.findByRole("heading", { name: "Import from Slackbot YAML" }),
  ).toBeInTheDocument();
  const reloadButton = screen.getByRole("button", { name: "Reload Bot Cache" });
  await waitFor(() => expect(reloadButton).not.toBeDisabled());
  fireEvent.click(reloadButton);
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith(
      "Slack bot route cache reloaded.",
      "success",
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Import from YAML" }));
  const importButton = await screen.findByRole("button", {
    name: "Apply Import",
  });
  fireEvent.click(importButton);
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith(
      expect.stringContaining("Config sync applied"),
      "success",
    ),
  );
});

it("organizes Slack admin into Configured / Onboard / Advanced tabs", async () => {
  render(<SlackChannelRebacPanel />);

  expect(
    await screen.findByRole("tab", { name: "Configured channels" }),
  ).toBeInTheDocument();

  // Configured tab is selected by default.
  expect(
    screen.getByRole("tab", { name: "Configured channels" }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    screen.getByRole("region", { name: "Configured Slack channels" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("region", {
      name: "Default team and agent for new channels",
    }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("region", {
      name: "Advanced Setup - Import/Sync with Slackbot",
    }),
  ).not.toBeInTheDocument();

  // Onboard tab swaps in discovery wizard, hides the configured table.
  await switchToTab("Onboard channels");
  expect(
    screen.getByRole("button", { name: "Find channels" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Slack channels setup details" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Slack access details" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(
      /Members of the assigned team can update this Slack channel's bot routing/i,
    ),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/user:\* can_use agent/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/Sharing model:/i)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "Configured Slack channels" }),
  ).not.toBeInTheDocument();

  // Advanced tab shows runtime status + YAML import controls only.
  await switchToTab("Advanced");
  expect(
    await screen.findByRole("region", {
      name: "Advanced Setup - Import/Sync with Slackbot",
    }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("region", {
      name: "Default team and agent for new channels",
    }),
  ).not.toBeInTheDocument();
});

it("writes the active sub-tab to the subtab URL param", async () => {
  render(<SlackChannelRebacPanel />);
  await screen.findByRole("tab", { name: "Configured channels" });

  await switchToTab("Advanced");
  expect(replaceMock).toHaveBeenLastCalledWith("/admin/integrations/slack?subtab=advanced", {
    scroll: false,
  });

  await switchToTab("Onboard channels");
  expect(replaceMock).toHaveBeenLastCalledWith("/admin/integrations/slack?subtab=onboard", {
    scroll: false,
  });

  await switchToTab("Configured channels");
  expect(replaceMock).toHaveBeenLastCalledWith("/admin/integrations/slack?subtab=channels", {
    scroll: false,
  });
});

it("opens the sub-tab named by the subtab URL param on load", async () => {
  currentSearchParams = new URLSearchParams("subtab=advanced");
  render(<SlackChannelRebacPanel />);

  expect(await screen.findByRole("tab", { name: "Advanced" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    await screen.findByRole("region", {
      name: "Advanced Setup - Import/Sync with Slackbot",
    }),
  ).toBeInTheDocument();
});

it("deep-links and updates the configured channel search", async () => {
  currentSearchParams = new URLSearchParams(
    "subtab=channels&slackChannelSearch=incidents",
  );
  const { rerender } = render(<SlackChannelRebacPanel />);

  const searchInput = await screen.findByRole("textbox", {
    name: "Search configured channels",
  });
  expect(searchInput).toHaveValue("incidents");
  expect(await screen.findByText("#incidents")).toBeInTheDocument();

  fireEvent.change(searchInput, { target: { value: "platform-engineering" } });
  expect(replaceMock).toHaveBeenLastCalledWith(
    "/admin/integrations/slack?subtab=channels&slackChannelSearch=platform-engineering",
    { scroll: false },
  );

  currentSearchParams = new URLSearchParams(
    "subtab=channels&slackChannelSearch=C123456789",
  );
  rerender(<SlackChannelRebacPanel />);
  expect(searchInput).toHaveValue("C123456789");

  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(replaceMock).toHaveBeenLastCalledWith(
    "/admin/integrations/slack?subtab=channels",
    { scroll: false },
  );
});

it("shows Slack bot runtime sync status and triggers reload/config sync", async () => {
  render(<SlackChannelRebacPanel />);
  await switchToTab("Advanced");

  expect(
    await screen.findByRole("heading", { name: "Import from Slackbot YAML" }),
  ).toBeInTheDocument();
  expect(screen.getByText("db_prefer")).toBeInTheDocument();
  expect(screen.getByText(/1 cached channel/i)).toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "Slackbot sync legend" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Help: Route mode" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Help: Static config" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Help: Route cache" }),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Reload Bot Cache" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/slack/runtime/reload",
      expect.objectContaining({ method: "POST" }),
    ),
  );

  // Reload sets loading=true which disables Import from YAML; wait
  // for the click to take effect before firing the next one.
  const previewButton = screen.getByRole("button", {
    name: "Import from YAML",
  });
  await waitFor(() => expect(previewButton).not.toBeDisabled());
  fireEvent.click(previewButton);
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/slack/runtime/sync-from-config",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ dry_run: true }),
      }),
    ),
  );
  expect(await screen.findByText("Preview complete")).toBeInTheDocument();

  const importButton = screen.getByRole("button", { name: "Apply Import" });
  await waitFor(() => expect(importButton).not.toBeDisabled());
  fireEvent.click(importButton);
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/slack/runtime/sync-from-config",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ dry_run: false }),
      }),
    ),
  );
  expect(await screen.findByText("Apply complete")).toBeInTheDocument();
});

it("opens a runtime sync modal with preview progress and apply results", async () => {
  render(<SlackChannelRebacPanel />);
  await switchToTab("Advanced");

  fireEvent.click(
    await screen.findByRole("button", { name: "Import from YAML" }),
  );

  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  expect(screen.getByText("Slack Bot Config Sync Preview")).toBeInTheDocument();
  expect(await screen.findByText("Preview complete")).toBeInTheDocument();
  expect(screen.getByText("1 route planned")).toBeInTheDocument();
  expect(screen.getByText("1 channel scanned")).toBeInTheDocument();
  expect(screen.getByText("0 routes upserted")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Apply Import" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/slack/runtime/sync-from-config",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ dry_run: false }),
      }),
    ),
  );
  expect(await screen.findByText("Apply complete")).toBeInTheDocument();
  expect(screen.getByText("1 route upserted")).toBeInTheDocument();
  expect(screen.getByText("1 access grant written")).toBeInTheDocument();
});
