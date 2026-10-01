/**
 * @jest-environment jsdom
 *
 * Inline discovery-cache popover that lives next to the connector discovery
 * button on the Slack and Webex onboarding wizards.
 * Tests cover:
 *   - Lazy GET only fires when the popover is opened (no popup = no
 *     extra round-trip on the integrations page)
 *   - TTL input is pre-filled from platform_config
 *   - Save PATCHes the right field; client-side validates the range
 *   - "Refresh from <provider> now" hits the right per-provider route with
 *     refresh=1 and fires onAfterRefresh
 *   - Read-only viewers see the TTL but no Save/refresh controls
 *
 * assisted-by Cursor claude-opus-4-7
 */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DiscoveryCacheControls } from "../DiscoveryCacheControls";

type FetchInit = RequestInit | undefined;

function mockFetch({
  ttl = 60,
  webexTtl,
  patch = { success: true },
  refresh = { ok: true, status: 200 },
  onCall,
}: {
  ttl?: number;
  webexTtl?: number;
  patch?: { success: boolean; error?: string };
  refresh?: { ok?: boolean; status?: number };
  onCall?: (href: string, init: FetchInit) => void;
} = {}) {
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const href = String(input);
    onCall?.(href, init);
    if (href.includes("/api/admin/platform-config") && init?.method === "PATCH") {
      return Promise.resolve({
        json: () => Promise.resolve(patch),
      } as Response);
    }
    if (href.includes("/api/admin/platform-config")) {
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            success: true,
            data: {
              default_agent_id: null,
              slack_discovery_cache_ttl_minutes: ttl,
              webex_discovery_cache_ttl_minutes: webexTtl ?? ttl,
            },
          }),
      } as Response);
    }
    if (
      href.includes("/api/admin/slack/available-channels") ||
      href.includes("/api/admin/webex/available-spaces")
    ) {
      return Promise.resolve({
        ok: refresh.ok ?? true,
        status: refresh.status ?? 200,
        json: () => Promise.resolve({ success: true }),
      } as unknown as Response);
    }
    return Promise.reject(new Error(`Unexpected fetch: ${href}`));
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("DiscoveryCacheControls", () => {
  it("does not fetch platform-config until the popover is opened (no work for closed UI)", async () => {
    mockFetch();

    render(<DiscoveryCacheControls provider="slack" isAdmin />);

    // The trigger is rendered; nothing was fetched yet.
    expect(screen.getByTestId("discovery-cache-controls-trigger-slack")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Slack discovery cache settings" })).toHaveTextContent("Discovery cache");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("loads the persisted TTL when opened", async () => {
    mockFetch({ ttl: 30 });

    render(<DiscoveryCacheControls provider="slack" isAdmin />);
    fireEvent.click(screen.getByTestId("discovery-cache-controls-trigger-slack"));

    const input = (await screen.findByTestId(
      "discovery-cache-ttl-input-slack",
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("30"));
  });

  it("PATCHes the new TTL on save and reflects the new saved value", async () => {
    const calls: string[] = [];
    mockFetch({ ttl: 60, onCall: (href, init) => calls.push(`${init?.method ?? "GET"} ${href}`) });

    render(<DiscoveryCacheControls provider="slack" isAdmin />);
    fireEvent.click(screen.getByTestId("discovery-cache-controls-trigger-slack"));
    const input = await screen.findByTestId("discovery-cache-ttl-input-slack");
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("60"));

    fireEvent.change(input, { target: { value: "120" } });
    fireEvent.click(screen.getByTestId("discovery-cache-ttl-save-slack"));

    await waitFor(() => {
      expect(calls).toContainEqual(
        expect.stringContaining("PATCH /api/admin/platform-config"),
      );
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/admin/platform-config",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ slack_discovery_cache_ttl_minutes: 120 }),
      }),
    );
    expect(await screen.findByText(/saved/i)).toBeInTheDocument();
  });

  it("rejects out-of-range TTL client-side without firing a PATCH", async () => {
    mockFetch();

    render(<DiscoveryCacheControls provider="slack" isAdmin />);
    fireEvent.click(screen.getByTestId("discovery-cache-controls-trigger-slack"));
    const input = await screen.findByTestId("discovery-cache-ttl-input-slack");
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("60"));

    fireEvent.change(input, { target: { value: "5000" } });
    fireEvent.click(screen.getByTestId("discovery-cache-ttl-save-slack"));

    expect(
      await screen.findByText(/integer between 0 and 1440/i),
    ).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalledWith(
      "/api/admin/platform-config",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ slack_discovery_cache_ttl_minutes: 5000 }),
      }),
    );
  });

  it("loads the TTL for the selected connector", async () => {
    mockFetch({ ttl: 30, webexTtl: 90 });

    render(<DiscoveryCacheControls provider="webex" isAdmin />);
    fireEvent.click(screen.getByTestId("discovery-cache-controls-trigger-webex"));

    const input = await screen.findByTestId(
      "discovery-cache-ttl-input-webex",
    );
    await waitFor(() => expect(input).toHaveValue(90));
    expect(screen.queryByText(/shared between/i)).not.toBeInTheDocument();
  });

  it("force refresh hits only the Slack route when provider=slack and fires onAfterRefresh", async () => {
    const seen: string[] = [];
    mockFetch({ onCall: (href) => seen.push(href) });
    const onAfterRefresh = jest.fn();

    render(
      <DiscoveryCacheControls provider="slack" isAdmin onAfterRefresh={onAfterRefresh} />,
    );
    fireEvent.click(screen.getByTestId("discovery-cache-controls-trigger-slack"));
    await screen.findByTestId("discovery-cache-ttl-input-slack");
    expect(screen.getByRole("button", { name: "Refresh from Slack now" })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("discovery-cache-refresh-slack"));

    await waitFor(() => {
      expect(seen.some((h) => h.includes("/api/admin/slack/available-channels") && h.includes("refresh=1"))).toBe(true);
    });
    expect(seen.some((h) => h.includes("/api/admin/webex/available-spaces"))).toBe(false);
    await waitFor(() => expect(onAfterRefresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/refreshed/i)).toBeInTheDocument();
  });

  it("force refresh hits only the Webex route when provider=webex", async () => {
    const seen: string[] = [];
    mockFetch({ onCall: (href) => seen.push(href) });

    render(<DiscoveryCacheControls provider="webex" isAdmin />);
    fireEvent.click(screen.getByTestId("discovery-cache-controls-trigger-webex"));
    await screen.findByTestId("discovery-cache-ttl-input-webex");

    fireEvent.click(screen.getByTestId("discovery-cache-refresh-webex"));

    await waitFor(() => {
      expect(seen.some((h) => h.includes("/api/admin/webex/available-spaces") && h.includes("refresh=1"))).toBe(true);
    });
    expect(seen.some((h) => h.includes("/api/admin/slack/available-channels"))).toBe(false);
  });

  it("treats 503 from the discovery route as a no-op success (connector not configured)", async () => {
    mockFetch({ refresh: { ok: false, status: 503 } });
    const onAfterRefresh = jest.fn();

    render(
      <DiscoveryCacheControls provider="webex" isAdmin onAfterRefresh={onAfterRefresh} />,
    );
    fireEvent.click(screen.getByTestId("discovery-cache-controls-trigger-webex"));
    await screen.findByTestId("discovery-cache-ttl-input-webex");

    fireEvent.click(screen.getByTestId("discovery-cache-refresh-webex"));

    expect(await screen.findByText(/refreshed/i)).toBeInTheDocument();
    expect(onAfterRefresh).toHaveBeenCalledTimes(1);
  });

  it("hides Save and Force-refresh for read-only viewers but keeps the TTL visible", async () => {
    mockFetch({ ttl: 45 });

    render(<DiscoveryCacheControls provider="slack" isAdmin={false} />);
    fireEvent.click(screen.getByTestId("discovery-cache-controls-trigger-slack"));

    const input = (await screen.findByTestId(
      "discovery-cache-ttl-input-slack",
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("45"));
    expect(input).toBeDisabled();
    expect(screen.queryByTestId("discovery-cache-ttl-save-slack")).not.toBeInTheDocument();
    expect(screen.queryByTestId("discovery-cache-refresh-slack")).not.toBeInTheDocument();
  });
});
