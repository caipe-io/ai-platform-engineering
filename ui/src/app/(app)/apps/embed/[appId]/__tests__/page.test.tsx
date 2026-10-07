import { redirect } from "next/navigation";

import LegacyAgenticAppEmbedPage from "../page";

jest.mock("next/navigation", () => ({
  redirect: jest.fn(() => {
    throw new Error("redirect");
  }),
}));

const mockRedirect = redirect as unknown as jest.Mock;

describe("LegacyAgenticAppEmbedPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("redirects the old embed URL to the canonical app route", async () => {
    await expect(
      LegacyAgenticAppEmbedPage({
        params: Promise.resolve({ appId: "ioc-kpi-dashboard" }),
        searchParams: Promise.resolve({ view: "summary" }),
      }),
    ).rejects.toThrow("redirect");

    expect(mockRedirect).toHaveBeenCalledWith(
      "/apps/ioc-kpi-dashboard?view=summary",
    );
  });

  it("preserves repeated query parameters", async () => {
    await expect(
      LegacyAgenticAppEmbedPage({
        params: Promise.resolve({ appId: "weather" }),
        searchParams: Promise.resolve({
          tab: ["forecast", "alerts"],
        }),
      }),
    ).rejects.toThrow("redirect");

    expect(mockRedirect).toHaveBeenCalledWith(
      "/apps/weather?tab=forecast&tab=alerts",
    );
  });
});
