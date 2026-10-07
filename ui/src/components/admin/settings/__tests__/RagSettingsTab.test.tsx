/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { RagSettingsTab } from "../RagSettingsTab";

jest.mock("../ImportRagSourcesFromConfigCard", () => ({
  ImportRagSourcesFromConfigCard: () => (
    <div data-testid="rag-migration-card" />
  ),
}));

describe("RagSettingsTab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      if (href === "/api/dynamic-agents/teams") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: [{ _id: "team-1", slug: "primary", name: "Primary" }],
          }),
        } as Response);
      }
      if (href === "/api/admin/platform-config" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: body }),
        } as Response);
      }
      if (href === "/api/admin/platform-config") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              rag_default_search_team_slug: "primary",
              rag_ingestor_limits: {
                slack: { max_lookback_days: 90 },
                web: { max_pages: 4_000 },
              },
            },
          }),
        } as Response);
      }
      return Promise.reject(new Error(`Unexpected fetch: ${href}`));
    });
  });

  it("loads persisted limits and saves a complete normalized policy", async () => {
    render(<RagSettingsTab isAdmin />);

    const lookback = screen.getByLabelText("Maximum lookback days");
    await waitFor(() => expect(lookback).toHaveValue(90));
    expect(screen.getByLabelText("Maximum pages")).toHaveValue(4_000);

    fireEvent.change(lookback, { target: { value: "180" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Save Ingestor Policies" }),
    );

    await waitFor(() => {
      expect(
        screen.getByText("RAG ingestor policies saved."),
      ).toBeInTheDocument();
    });
    const patchCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/admin/platform-config" &&
        init?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    const body = JSON.parse(String(patchCall![1].body));
    expect(body.rag_ingestor_limits.slack.max_lookback_days).toBe(180);
    expect(body.rag_ingestor_limits.web.max_pages).toBe(4_000);
    expect(body.rag_ingestor_limits.shared.max_chunk_size).toBe(100_000);
  });

  it("keeps policy controls disabled for a read-only admin view", async () => {
    render(<RagSettingsTab isAdmin readOnly />);

    expect(
      await screen.findByLabelText("Maximum lookback days"),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Save Ingestor Policies" }),
    ).toBeDisabled();
  });

  it("does not duplicate collection navigation in RAG settings", async () => {
    render(<RagSettingsTab isAdmin />);

    expect(await screen.findByText("RAG Defaults")).toBeInTheDocument();
    expect(
      screen.queryByText("Maintained RAG Collections"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Manage RAG Collections/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps shared settings open and groups each option with its connector", async () => {
    render(<RagSettingsTab isAdmin />);

    await screen.findByText("RAG Defaults");
    const sharedHeading = screen.getByRole("heading", { name: "Shared" });
    expect(sharedHeading.closest("details")).toBeNull();
    expect(screen.queryByText("Allowed connector features")).not.toBeInTheDocument();

    const slackSection = screen.getByText("Slack", { selector: "summary" })
      .closest("details");
    expect(slackSection).not.toBeNull();
    expect(
      within(slackSection as HTMLElement).getByLabelText(
        "Allow full channel history",
      ),
    ).toBeInTheDocument();

    const webexSection = screen.getByText("Webex", { selector: "summary" })
      .closest("details");
    expect(webexSection).not.toBeNull();
    expect(
      within(webexSection as HTMLElement).getByLabelText("Allow bot messages"),
    ).toBeInTheDocument();
  });

  it("shows one Admin badge for the whole RAG page", async () => {
    render(<RagSettingsTab isAdmin />);

    await screen.findByText("RAG Defaults");
    expect(screen.getAllByText("Admin")).toHaveLength(1);
  });
});
