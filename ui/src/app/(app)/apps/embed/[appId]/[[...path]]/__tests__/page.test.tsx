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

  it("redirects an old embed URL to the canonical app route", async () => {
    await expect(
      LegacyAgenticAppEmbedPage({
        params: Promise.resolve({ appId: "kaleidoscope" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("redirect");

    expect(mockRedirect).toHaveBeenCalledWith("/apps/kaleidoscope");
  });

  it("preserves and encodes the app id and nested app path", async () => {
    await expect(
      LegacyAgenticAppEmbedPage({
        params: Promise.resolve({
          appId: "research / insights",
          path: ["studies", "Q3/2026", "résumé 100%"],
        }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("redirect");

    expect(mockRedirect).toHaveBeenCalledWith(
      "/apps/research%20%2F%20insights/studies/Q3%2F2026/r%C3%A9sum%C3%A9%20100%25",
    );
  });

  it("preserves repeated, empty, and encoded query parameters", async () => {
    await expect(
      LegacyAgenticAppEmbedPage({
        params: Promise.resolve({ appId: "weather", path: ["forecast"] }),
        searchParams: Promise.resolve({
          returnTo: "/studies/a b?mode=edit",
          filter: ["new/open", "high priority"],
          empty: "",
          ignored: undefined,
        }),
      }),
    ).rejects.toThrow("redirect");

    expect(mockRedirect).toHaveBeenCalledWith(
      "/apps/weather/forecast?returnTo=%2Fstudies%2Fa+b%3Fmode%3Dedit&filter=new%2Fopen&filter=high+priority&empty=",
    );
  });
});
