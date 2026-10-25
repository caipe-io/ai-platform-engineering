import { fireEvent, render, screen } from "@testing-library/react";
import { ReleaseNotesPreview } from "../ReleaseNotesPreview";

jest.mock("@/components/release/ReleaseUpgradeDialog", () => ({
  ReleaseUpgradeDialog: ({ open, releaseMarkdown }: { open: boolean; releaseMarkdown: { body: string } | null }) =>
    open ? <div role="dialog">{releaseMarkdown?.body ?? "No matching notes"}</div> : null,
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
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });
});
