import { act, renderHook, waitFor } from "@testing-library/react";

const mockUseSession = jest.fn();
const mockUseVersion = jest.fn();
const mockUseAdminRole = jest.fn();

jest.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

jest.mock("../use-version", () => ({
  useVersion: () => mockUseVersion(),
}));

jest.mock("../use-admin-role", () => ({
  useAdminRole: () => mockUseAdminRole(),
}));

import { useReleaseUpgradePrompt } from "../use-release-upgrade-prompt";

function jsonResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    json: async () => payload,
  } as Response;
}

const changelogPayload = {
  releases: [
    {
      version: "0.5.1",
      date: "2026-05-19",
      sections: [{ type: "Features", items: [{ text: "Added migrations", scope: null }] }],
    },
  ],
  scopes: [],
};

describe("useReleaseUpgradePrompt", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
    mockUseSession.mockReturnValue({
      status: "authenticated",
      data: { user: { email: "admin@example.com" } },
    });
    mockUseVersion.mockReturnValue({
      isLoading: false,
      versionInfo: { version: "0.5.1", packageVersion: "0.5.1", gitCommit: "abc", buildDate: "today" },
    });
    mockUseAdminRole.mockReturnValue({ isAdmin: true, loading: false });
    global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      if (href === "/api/settings") {
        return jsonResponse({
          success: true,
          data: { preferences: { releaseNotesDismissedVersions: [] } },
        });
      }
      if (href === "/api/changelog") {
        return jsonResponse(changelogPayload);
      }
      if (href === "/api/admin/platform-config") {
        return jsonResponse({
          success: true,
          data: { release_notes: { enabled: true } },
        });
      }
      if (href.startsWith("/api/release-notes")) {
        return jsonResponse({
          requestedVersion: "0.5.1",
          matchedVersion: "0.5.1",
          title: "Release 0.5.1",
          date: "2026-05-19",
          body: "Curated release notes body",
          source: "github",
        });
      }
      if (href === "/api/settings/preferences" && init?.method === "PATCH") {
        return jsonResponse({ success: true });
      }
      return jsonResponse({}, false);
    }) as jest.Mock;
  });

  it("shows an admin prompt for the deployed release", async () => {
    const { result } = renderHook(() => useReleaseUpgradePrompt());

    await waitFor(() => {
      expect(result.current.open).toBe(true);
    });

    expect(result.current.releaseVersion).toBe("0.5.1");
    expect(result.current.release?.sections[0].items[0].text).toBe("Added migrations");
    expect(result.current.releaseMarkdown).toBeNull();
    expect(result.current.isAdmin).toBe(true);
  });

  it("uses the configured compare range and a range-specific dismissal", async () => {
    const fallback = global.fetch;
    (global.fetch as jest.Mock) = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === "/api/admin/platform-config") return jsonResponse({ success: true, data: { release_notes: {
        enabled: true, repository_url: "https://github.com/example/repository", previous_commit: "1111111", latest_commit: "2222222",
      } } });
      if (String(url).includes("compare=platform")) return jsonResponse({
        matchedVersion: "0.5.1", body: "Configured changes", source: "github-compare",
        changelogUrl: "https://github.com/example/repository/compare/1111111...2222222",
      });
      return fallback(url, init);
    });
    const { result } = renderHook(() => useReleaseUpgradePrompt());
    await waitFor(() => expect(result.current.open).toBe(true));
    expect(result.current.release).toBeNull();
    expect(result.current.releaseMarkdown?.body).toBe("Configured changes");
    expect(global.fetch).toHaveBeenCalledWith("/api/release-notes?version=0.5.1&compare=platform");
    await act(async () => { await result.current.dismissPermanently(); });
    expect(global.fetch).toHaveBeenCalledWith("/api/settings/preferences", expect.objectContaining({
      body: JSON.stringify({ releaseNotesDismissedVersions: [JSON.stringify([
        "0.5.1", "https://github.com/example/repository", "1111111", "2222222",
      ])] }),
    }));
  });

  it("uses exact changelog entries before exact curated release markdown", async () => {
    const { result } = renderHook(() => useReleaseUpgradePrompt());

    await waitFor(() => expect(result.current.open).toBe(true));

    expect(result.current.release?.version).toBe("0.5.1");
    expect(result.current.releaseMarkdown).toBeNull();
    expect(global.fetch).toHaveBeenCalledWith("/api/release-notes?version=0.5.1");
  });

  it("uses exact curated release markdown only when the changelog has no exact entry", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href === "/api/settings") {
        return jsonResponse({
          success: true,
          data: { preferences: { releaseNotesDismissedVersions: [] } },
        });
      }
      if (href === "/api/changelog") {
        return jsonResponse({ releases: [], scopes: [] });
      }
      if (href === "/api/admin/platform-config") {
        return jsonResponse({ success: true, data: { release_notes: { enabled: true } } });
      }
      if (href.startsWith("/api/release-notes")) {
        return jsonResponse({
          requestedVersion: "0.5.1",
          matchedVersion: "0.5.1",
          title: "Release 0.5.1",
          date: "2026-05-19",
          body: "Curated release notes body",
          source: "github",
        });
      }
      return jsonResponse({}, false);
    });

    const { result } = renderHook(() => useReleaseUpgradePrompt());

    await waitFor(() => expect(result.current.open).toBe(true));

    expect(result.current.release).toBeNull();
    expect(result.current.releaseMarkdown?.body).toBe("Curated release notes body");
  });

  it("stores admin skip until next login only in sessionStorage", async () => {
    const { result } = renderHook(() => useReleaseUpgradePrompt());

    await waitFor(() => expect(result.current.open).toBe(true));

    act(() => result.current.skipUntilNextLogin());

    expect(window.sessionStorage.getItem("release-notes:0.5.1:skip")).toBe("true");
    expect(global.fetch).not.toHaveBeenCalledWith("/api/settings/preferences", expect.anything());
    expect(result.current.open).toBe(false);
  });

  it("stores permanent dismissal in user preferences", async () => {
    const { result } = renderHook(() => useReleaseUpgradePrompt());

    await waitFor(() => expect(result.current.open).toBe(true));

    await act(async () => {
      await result.current.dismissPermanently();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/settings/preferences",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          releaseNotesDismissedVersions: ["0.5.1"],
        }),
      }),
    );
    expect(result.current.open).toBe(false);
  });

  it("closes release notes locally when dismissal persistence fails", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    (global.fetch as jest.Mock).mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      if (href === "/api/settings") {
        return jsonResponse({
          success: true,
          data: { preferences: { releaseNotesDismissedVersions: [] } },
        });
      }
      if (href === "/api/changelog") {
        return jsonResponse(changelogPayload);
      }
      if (href === "/api/admin/platform-config") {
        return jsonResponse({ success: true, data: { release_notes: { enabled: true } } });
      }
      if (href === "/api/settings/preferences" && init?.method === "PATCH") {
        return jsonResponse({ success: false }, false);
      }
      return jsonResponse({}, false);
    });

    try {
      const { result } = renderHook(() => useReleaseUpgradePrompt());

      await waitFor(() => expect(result.current.open).toBe(true));

      await act(async () => {
        await result.current.dismissPermanently();
      });

      expect(global.fetch).toHaveBeenCalledWith(
        "/api/settings/preferences",
        expect.objectContaining({ method: "PATCH" }),
      );
      expect(window.sessionStorage.getItem("release-notes:0.5.1:skip")).toBe("true");
      expect(result.current.open).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("shows non-admin release notes without admin mode and permanently dismisses", async () => {
    mockUseAdminRole.mockReturnValue({ isAdmin: false, loading: false });
    const { result } = renderHook(() => useReleaseUpgradePrompt());

    await waitFor(() => expect(result.current.open).toBe(true));

    expect(result.current.isAdmin).toBe(false);

    await act(async () => {
      await result.current.dismissPermanently();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/settings/preferences",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          releaseNotesDismissedVersions: ["0.5.1"],
        }),
      }),
    );
  });

  it("always announces the currently deployed version", async () => {
    mockUseVersion.mockReturnValue({
      isLoading: false,
      versionInfo: { version: "0.6.0", packageVersion: "0.6.0", gitCommit: "abc", buildDate: "today" },
    });
    (global.fetch as jest.Mock).mockImplementation(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href === "/api/settings") {
        return jsonResponse({
          success: true,
          data: { preferences: { releaseNotesDismissedVersions: [] } },
        });
      }
      if (href === "/api/admin/platform-config") {
        return jsonResponse({ success: true, data: { release_notes: { enabled: true } } });
      }
      if (href === "/api/changelog") {
        return jsonResponse({
          releases: [
            {
              version: "0.6.0",
              date: "2026-06-01",
              sections: [{ type: "Features", items: [{ text: "Future release", scope: null }] }],
            },
          ],
        });
      }
      return jsonResponse({}, false);
    });

    const { result } = renderHook(() => useReleaseUpgradePrompt());

    await waitFor(() => expect(result.current.open).toBe(true));
    expect(result.current.releaseVersion).toBe("0.6.0");
  });

  it("suppresses the prompt when the platform-wide switch is off", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href === "/api/settings") {
        return jsonResponse({
          success: true,
          data: { preferences: { releaseNotesDismissedVersions: [] } },
        });
      }
      if (href === "/api/admin/platform-config") {
        return jsonResponse({ success: true, data: { release_notes: { enabled: false } } });
      }
      if (href === "/api/changelog") return jsonResponse(changelogPayload);
      return jsonResponse({}, false);
    });

    const { result } = renderHook(() => useReleaseUpgradePrompt());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.open).toBe(false);
  });

  it("suppresses the prompt when the user disabled release note notifications for their account", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href === "/api/settings") {
        return jsonResponse({
          success: true,
          data: {
            preferences: {
              releaseNotesNotificationsEnabled: false,
              releaseNotesDismissedVersions: [],
            },
          },
        });
      }
      if (href === "/api/admin/platform-config") {
        return jsonResponse({ success: true, data: { release_notes: { enabled: true } } });
      }
      if (href === "/api/changelog") return jsonResponse(changelogPayload);
      return jsonResponse({}, false);
    });

    const { result } = renderHook(() => useReleaseUpgradePrompt());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.open).toBe(false);
  });

  it("does not show for unauthenticated users or dismissed releases", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href === "/api/settings") {
        return jsonResponse({ success: true, data: { preferences: {} } });
      }
      if (href === "/api/admin/platform-config") {
        return jsonResponse({ success: true, data: {} });
      }
      if (href === "/api/changelog") return jsonResponse(changelogPayload);
      return jsonResponse({}, false);
    });
    mockUseVersion.mockReturnValue({
      isLoading: false,
      versionInfo: { version: "0.5.1", packageVersion: "0.5.1", gitCommit: "abc", buildDate: "today" },
    });
    mockUseSession.mockReturnValue({ status: "unauthenticated", data: null });
    const unauthenticated = renderHook(() => useReleaseUpgradePrompt());
    await waitFor(() => expect(unauthenticated.result.current.isLoading).toBe(false));
    expect(unauthenticated.result.current.open).toBe(false);

    mockUseSession.mockReturnValue({
      status: "authenticated",
      data: { user: { email: "admin@example.com" } },
    });
    (global.fetch as jest.Mock).mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url) === "/api/settings") {
        return jsonResponse({
          success: true,
          data: { preferences: { releaseNotesDismissedVersions: ["0.5.1"] } },
        });
      }
      if (String(url) === "/api/admin/platform-config") {
        return jsonResponse({ success: true, data: { release_notes: { enabled: true } } });
      }
      if (String(url) === "/api/changelog") return jsonResponse(changelogPayload);
      return jsonResponse({}, false);
    });
    const dismissed = renderHook(() => useReleaseUpgradePrompt());
    await waitFor(() => expect(dismissed.result.current.isLoading).toBe(false));
    expect(dismissed.result.current.open).toBe(false);
  });
});
