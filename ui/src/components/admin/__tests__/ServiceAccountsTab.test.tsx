/** @jest-environment jsdom */

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

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
