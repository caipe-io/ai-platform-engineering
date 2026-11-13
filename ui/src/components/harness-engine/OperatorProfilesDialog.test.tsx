import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OperatorProfilesDialog } from "./OperatorProfilesDialog";
jest.mock("@/components/ui/searchable-picker", () => ({ SearchablePicker: ({ options, onSelect, ariaLabel, disabled }: { disabled?: boolean; options: { id: string; display_name: string }[]; onSelect: (p: unknown) => void; ariaLabel: string }) => <button type="button" disabled={disabled || !options.length} aria-label={ariaLabel} onClick={() => onSelect(options[0])}>Choose</button> }));
beforeEach(() => jest.resetAllMocks());
afterEach(() => jest.restoreAllMocks());
it("publishes the model policy and selects it without sending connection settings", async () => {
  const created = jest.fn().mockResolvedValue(undefined);
  const close = jest.fn();
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { profiles: [], harnesses: [{ id: "claude_code_cli_acp", profiles: [{ id: "primary", display_name: "Primary", available: true, source: "deployment" }] }] } }) } as Response).mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { profile_id: "managed-long-v1", max_turns: 50 } }) } as Response);
  render(<OperatorProfilesDialog open onOpenChange={close} harnessId="claude_code_cli_acp" onCreated={created} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  // Wait for the fetched configuration to populate the picker.
  await waitFor(() => expect(screen.getByRole("button", { name: "Create and select profile" })).toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "Worker configuration" }));
  fireEvent.change(screen.getByLabelText("New profile ID"), { target: { value: "managed-long-v1" } });
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Long investigation" } });
  fireEvent.change(screen.getByLabelText("Execution model ID"), { target: { value: "example-model" } });
  fireEvent.change(screen.getByLabelText("Default maximum turns"), { target: { value: "50" } });
  fireEvent.click(screen.getByRole("button", { name: "Create and select profile" }));
  await waitFor(() => expect(created).toHaveBeenCalledWith("managed-long-v1", 50));
  expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).toEqual({ profile_id: "managed-long-v1", harness_id: "claude_code_cli_acp", base_profile_id: "primary", display_name: "Long investigation", model: "example-model", max_turns: 50 });
  expect(close).toHaveBeenCalledWith(false);
  fetchMock.mockRestore();
});

const profileCatalog = { profiles: [], harnesses: [{ id: "claude_code_cli_acp", profiles: [{ id: "primary", display_name: "Primary", available: true, source: "deployment" }] }] };
function reply(data: unknown, ok = true) { return { ok, json: async () => ({ success: ok, ...data as object }) } as Response; }
async function fillProfile(id = "100", turns = "100") {
  await waitFor(() => expect(screen.getByRole("button", { name: "Worker configuration" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Worker configuration" }));
  fireEvent.change(screen.getByLabelText("New profile ID"), { target: { value: id } });
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "100-turns" } });
  fireEvent.change(screen.getByLabelText("Execution model ID"), { target: { value: "example-model" } });
  fireEvent.change(screen.getByLabelText("Default maximum turns"), { target: { value: turns } });
}
it("accepts a numeric suffix and 100 turns, previews the full ID, and sends the required namespace", async () => {
  const created = jest.fn().mockResolvedValue(undefined);
  const fetcher = jest.spyOn(global, "fetch").mockResolvedValueOnce(reply({ data: profileCatalog })).mockResolvedValueOnce(reply({ data: { profile_id: "managed-100", max_turns: 100 } }));
  render(<OperatorProfilesDialog open onOpenChange={jest.fn()} harnessId="claude_code_cli_acp" onCreated={created} />);
  await fillProfile();
  expect(screen.getByText("managed-100", { selector: "code" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Create and select profile" }));
  await waitFor(() => expect(created).toHaveBeenCalledWith("managed-100", 100));
  expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toMatchObject({ profile_id: "managed-100", max_turns: 100 });
});
it.each(["Upper Case", "managed-", "-invalid", "a".repeat(56)])("rejects invalid ID %s locally without a save request", async id => {
  const fetcher = jest.spyOn(global, "fetch").mockResolvedValue(reply({ data: profileCatalog }));
  render(<OperatorProfilesDialog open onOpenChange={jest.fn()} harnessId="claude_code_cli_acp" onCreated={jest.fn()} />);
  await fillProfile(id);
  fireEvent.click(screen.getByRole("button", { name: "Create and select profile" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("1–55 lowercase");
  expect(screen.getByLabelText("New profile ID")).toHaveAttribute("aria-invalid", "true");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(["0", "101", "1.5"])("rejects invalid maximum turns %s locally", async turns => {
  const fetcher = jest.spyOn(global, "fetch").mockResolvedValue(reply({ data: profileCatalog }));
  render(<OperatorProfilesDialog open onOpenChange={jest.fn()} harnessId="claude_code_cli_acp" onCreated={jest.fn()} />);
  await fillProfile("100", turns);
  fireEvent.click(screen.getByRole("button", { name: "Create and select profile" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("whole number from 1 to 100");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("renders structured validation errors with field names and preserves the draft on reload", async () => {
  const fetcher = jest.spyOn(global, "fetch").mockResolvedValueOnce(reply({ data: profileCatalog }))
    .mockResolvedValueOnce(reply({ detail: [{ loc: ["body", "model"], msg: "Model is unavailable" }] }, false)).mockResolvedValueOnce(reply({ data: profileCatalog }));
  render(<OperatorProfilesDialog open onOpenChange={jest.fn()} harnessId="claude_code_cli_acp" onCreated={jest.fn()} />);
  await fillProfile();
  fireEvent.click(screen.getByRole("button", { name: "Create and select profile" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Execution model ID: Model is unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Reload profiles" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  expect(screen.getByLabelText("New profile ID")).toHaveValue("100");
  expect(screen.getByLabelText("Default maximum turns")).toHaveValue(100);
});
it("rejects a reused profile ID across runtimes without overwriting it", async () => {
  const fetcher = jest.spyOn(global, "fetch").mockResolvedValue(reply({ data: { ...profileCatalog, profiles: [{ profile_id: "managed-100", harness_id: "claude_agent_sdk" }] } }));
  render(<OperatorProfilesDialog open onOpenChange={jest.fn()} harnessId="claude_code_cli_acp" onCreated={jest.fn()} />);
  await fillProfile();
  fireEvent.click(screen.getByRole("button", { name: "Create and select profile" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
