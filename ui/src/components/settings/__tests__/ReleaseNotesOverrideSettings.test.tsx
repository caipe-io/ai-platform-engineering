import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReleaseNotesOverrideSettings } from "../ReleaseNotesOverrideSettings";
const mockUseVersion = jest.fn();
jest.mock("@/hooks/use-version", () => ({ useVersion: () => mockUseVersion() }));
jest.mock("@/components/release/ReleaseUpgradeDialog", () => ({ ReleaseUpgradeDialog: ({ open, releaseMarkdown }: { open: boolean; releaseMarkdown: { body: string } }) => open ? <pre data-testid="preview">{releaseMarkdown.body}</pre> : null }));
const originalFetch = global.fetch;
beforeEach(() => {
  mockUseVersion.mockReturnValue({ isLoading: false, versionInfo: { version: "1.3.5", packageVersion: "0.2.0" } });
});
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

test.each(["manual", "repository"])("defaults a new %s override to the deployed host release", async (source) => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { release_notes: {} } }) })) as jest.Mock;
  render(<ReleaseNotesOverrideSettings />);
  const select = await screen.findByLabelText("Content source");
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value: source } });
  expect(screen.getByLabelText("Deployed release version")).toHaveValue("1.3.5");
  expect(screen.getByText("Current host release: 1.3.5")).toBeInTheDocument();
});

test("keeps version entry available when the deployed version cannot be loaded", async () => {
  mockUseVersion.mockReturnValue({ isLoading: false, versionInfo: null });
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { release_notes: {} } }) })) as jest.Mock;
  render(<ReleaseNotesOverrideSettings />);
  const select = await screen.findByLabelText("Content source");
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value: "manual" } });
  expect(screen.getByLabelText("Deployed release version")).toHaveValue("");
  expect(screen.queryByRole("button", { name: "Use current host release" })).not.toBeInTheDocument();
});

test("keeps retargeting disabled in read-only mode", async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({
    success: true, data: { release_notes: { override: { source: "manual", release_version: "1.3.4", markdown: "Saved notes" } } },
  }) })) as jest.Mock;
  render(<ReleaseNotesOverrideSettings readOnly />);
  expect(await screen.findByRole("button", { name: "Use current host release" })).toBeDisabled();
});

test("explains a saved version mismatch and lets the user retarget without losing content", async () => {
  global.fetch = jest.fn(async (_url, init) => ({ ok: true, json: async () => init ? { success: true } : {
    success: true, data: { release_notes: { override: {
      source: "manual", release_version: "1.0.0-example.1", markdown: "## Improvements\nSaved notes",
    } } },
  } })) as jest.Mock;
  render(<ReleaseNotesOverrideSettings />);
  const input = await screen.findByLabelText("Deployed release version");
  await waitFor(() => expect(input).toBeEnabled());
  expect(input).toHaveValue("1.0.0-example.1");
  expect(screen.getByRole("alert")).toHaveTextContent("will not appear for the current host release (1.3.5)");
  fireEvent.click(screen.getByRole("button", { name: "Use current host release" }));
  expect(input).toHaveValue("1.3.5");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Release notes Markdown")).toHaveValue("## Improvements\nSaved notes");
  fireEvent.click(screen.getByRole("button", { name: "Save curated notes" }));
  await screen.findByRole("status");
  const call = (global.fetch as jest.Mock).mock.calls.find(([, init]) => init?.method === "PATCH");
  expect(JSON.parse(call![1].body).release_notes.override).toMatchObject({
    release_version: "1.3.5", markdown: "## Improvements\nSaved notes",
  });
});

test("makes clear that saved notes for another release are inactive", async () => {
  global.fetch = jest.fn(async (_url, init) => ({ ok: true, json: async () => init ? { success: true } : { success: true, data: { release_notes: {} } } })) as jest.Mock;
  render(<ReleaseNotesOverrideSettings />);
  const select = await screen.findByLabelText("Content source");
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value: "manual" } });
  fireEvent.change(screen.getByLabelText("Deployed release version"), { target: { value: "1.3.6" } });
  fireEvent.change(screen.getByLabelText("Release notes Markdown"), { target: { value: "Future release notes" } });
  fireEvent.click(screen.getByRole("button", { name: "Save curated notes" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Curated notes saved for 1.3.6. They will not appear for the current host release (1.3.5).");
});
