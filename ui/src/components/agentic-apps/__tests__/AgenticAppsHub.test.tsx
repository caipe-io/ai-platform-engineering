import { render, screen, waitFor } from "@testing-library/react";

import { AgenticAppsHub } from "../AgenticAppsHub";

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    getSettings: jest.fn().mockResolvedValue({ preferences: {} }),
  },
}));

describe("AgenticAppsHub", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("keeps the create/add flow discoverable when no apps are configured", async () => {
    render(<AgenticAppsHub />);

    await waitFor(() => {
      expect(
        screen.getAllByRole("link", { name: "Create or add your app" }),
      ).toHaveLength(2);
    });

    for (const link of screen.getAllByRole("link", { name: "Create or add your app" })) {
      expect(link).toHaveAttribute("href", "/apps/create");
    }
  });
});
