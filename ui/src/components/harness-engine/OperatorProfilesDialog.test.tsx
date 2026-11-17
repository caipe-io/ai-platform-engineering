import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OperatorProfilesDialog } from "./OperatorProfilesDialog";
jest.mock("@/components/ui/searchable-picker", () => ({ SearchablePicker: ({ options, onSelect, ariaLabel }: { options: { id: string; display_name: string }[]; onSelect: (p: unknown) => void; ariaLabel: string }) => <button type="button" aria-label={ariaLabel} onClick={() => onSelect(options[0])}>Choose</button> }));
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
