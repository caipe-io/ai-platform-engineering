import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReleaseNotesOverrideSettings } from "../ReleaseNotesOverrideSettings";
jest.mock("@/components/release/ReleaseUpgradeDialog", () => ({ ReleaseUpgradeDialog: ({ open, releaseMarkdown }: { open: boolean; releaseMarkdown: { body: string } }) => open ? <pre data-testid="preview">{releaseMarkdown.body}</pre> : null }));
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
test("saves manual content independently of comparison settings", async () => {
  global.fetch = jest.fn(async (_url, init) => ({ ok: true, json: async () => init ? { success: true } : { success: true, data: { release_notes: {} } } })) as jest.Mock;
  render(<ReleaseNotesOverrideSettings />);
  const select = await screen.findByLabelText("Content source");
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value: "manual" } });
  fireEvent.change(screen.getByLabelText("Deployed release version"), { target: { value: "1.3.2" } });
  fireEvent.change(screen.getByLabelText("Release notes Markdown"), { target: { value: "## Highlights\nNew feature" } });
  fireEvent.click(screen.getByRole("button", { name: "Save curated notes" }));
  await screen.findByRole("status");
  const call = (global.fetch as jest.Mock).mock.calls.find(([, init]) => init?.method === "PATCH");
  const body = JSON.parse(call![1].body);
  expect(body.release_notes.override).toMatchObject({ source: "manual", release_version: "1.3.2", markdown: "## Highlights\nNew feature" });
  expect(body.release_notes).not.toHaveProperty("previous_commit");
});

test("previews the parsed body with code indentation preserved", async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { release_notes: {} } }) })) as jest.Mock;
  render(<ReleaseNotesOverrideSettings />);
  const select = await screen.findByLabelText("Content source");
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value: "manual" } });
  fireEvent.change(screen.getByLabelText("Release notes Markdown"), { target: { value: "---\ntitle: Hidden metadata\n---\n    example command\n\n<!-- truncate -->" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview entered Markdown" }));
  expect(screen.getByTestId("preview").textContent).toBe("    example command");
});
