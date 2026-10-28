import { renderHook, waitFor } from "@testing-library/react";
import { useHomeFavoriteApps } from "../FavoriteAppsWidget";

describe("useHomeFavoriteApps", () => {
  afterEach(() => jest.restoreAllMocks());

  it("does not fetch the catalog when nothing is starred", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { favoriteAppIds: [] } }),
    });
    global.fetch = fetchMock;

    const { result } = renderHook(() => useHomeFavoriteApps(true));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings/preferences/favorite-apps",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(result.current).toEqual([]);
  });

  it("includes only starred apps the user can launch", async () => {
    const fetchMock = jest.fn().mockImplementation((url: string) => Promise.resolve({
      ok: true,
      json: async () => url === "/api/agentic-apps"
        ? { items: [
            { appId: "example", displayName: "Example app", canLaunch: true },
            { appId: "blocked", displayName: "Blocked app", canLaunch: false },
            { appId: "other", displayName: "Other app", canLaunch: true },
          ] }
        : { data: { favoriteAppIds: ["example", "blocked"] } },
    }));
    global.fetch = fetchMock;

    const { result } = renderHook(() => useHomeFavoriteApps(true));
    await waitFor(() => expect(result.current.map((app) => app.appId)).toEqual(["example"]));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agentic-apps",
      expect.objectContaining({ cache: "no-store" }),
    );
  });
});
