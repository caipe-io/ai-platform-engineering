import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReleaseNotesPreview } from "../ReleaseNotesPreview";

jest.mock("@/components/release/ReleaseUpgradeDialog", () => ({
  ReleaseUpgradeDialog: ({ open, releaseMarkdown, release }: { open: boolean; releaseMarkdown: { body: string } | null; release: { sections: { items: { text: string }[] }[] } | null }) =>
    open ? <div role="dialog">{releaseMarkdown?.body ?? release?.sections[0]?.items[0]?.text ?? "No matching notes"}</div> : null,
}));

describe("release notes preview", () => {
  const originalFetch = global.fetch;
  afterAll(() => { global.fetch = originalFetch; });
  it.each([
    ["1.0.0-example.1", "1.0.0-example.1", "Generated changes"],
    ["1.0.0-example.1", "0.9.0", "No matching notes"],
  ])("accepts exact build notes without borrowing an older version: %s / %s", async (version, matchedVersion, expected) => {
    global.fetch = jest.fn(async (url: RequestInfo | URL) => ({ ok: true, json: async () => {
      if (url === "/api/version") return { version };
      if (url === "/api/changelog") return { releases: [] };
      if (url === "/api/admin/platform-config") return { success: true, data: {} };
      return { matchedVersion, body: "Generated changes", source: "generated" };
    } })) as unknown as typeof fetch;
    render(<ReleaseNotesPreview isAdmin />);
    fireEvent.click(screen.getByRole("button", { name: "Show current release notes" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Show current release notes" })).toBeEnabled());
    expect(screen.getByText(expected)).toBeInTheDocument();
  });
  it.each([
    ["1.3.4", "1.3.0", "github", false, "Blog notes"],
    ["1.3.4-example.1", "1.3.0", "local", false, "Blog notes"],
    ["1.3.4", "1.3.4", "github", true, "Blog notes"],
    ["1.3.4", "1.3.0", "github", true, "Blog notes"],
    ["1.3.4", "1.3.3", "github", true, "Changelog notes"],
    ["1.3.4", "1.2.0", "github", false, "No matching notes"],
    ["1.3.4", "1.3.0", "generated", false, "No matching notes"],
    ["1.3.4", "1.3.4", "manual", true, "Changelog notes"],
  ])("matches automatic preview notes for %s / %s / %s (changelog: %s)", async (version, matchedVersion, source, hasChangelog, expected) => {
    global.fetch = jest.fn(async (url: RequestInfo | URL) => ({ ok: true, json: async () => {
      if (url === "/api/version") return { version };
      if (url === "/api/changelog") return { releases: hasChangelog ? [{
        version, sections: [{ type: "Features", items: [{ text: "Changelog notes" }] }],
      }] : [] };
      if (url === "/api/admin/platform-config") return { data: {} };
      return { matchedVersion, body: "Blog notes", source };
    } })) as unknown as typeof fetch;
    render(<ReleaseNotesPreview isAdmin />);
    fireEvent.click(screen.getByRole("button", { name: "Show current release notes" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Show current release notes" })).toBeEnabled());
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/release-notes?"));
  });

  it.each(["http", "network"])("keeps the changelog when automatic notes fail with a %s error", async failure => {
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
      if (String(url).startsWith("/api/release-notes")) {
        if (failure === "network") throw new Error("Unavailable");
        return { ok: false, json: async () => ({ error: "Unavailable" }) };
      }
      return { ok: true, json: async () => {
        if (url === "/api/version") return { version: "1.3.4" };
        if (url === "/api/changelog") return { releases: [{
          version: "1.3.4", sections: [{ type: "Features", items: [{ text: "Changelog notes" }] }],
        }] };
        return { data: {} };
      } };
    }) as unknown as typeof fetch;
    render(<ReleaseNotesPreview isAdmin />);
    fireEvent.click(screen.getByRole("button", { name: "Show current release notes" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Show current release notes" })).toBeEnabled());
    expect(screen.getByText("Changelog notes")).toBeInTheDocument();
  });

});
