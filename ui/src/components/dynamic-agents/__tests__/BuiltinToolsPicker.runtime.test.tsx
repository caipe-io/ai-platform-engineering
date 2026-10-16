import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BuiltinToolsPicker } from "../BuiltinToolsPicker";

const definitions = [
  { id: "unsupported_example", name: "Unsupported Example", description: "Unsupported runtime tool", enabled_by_default: true, config_fields: [] },
  { id: "fetch_url", name: "Fetch URL", description: "Approved network tool", enabled_by_default: false, config_fields: [] },
];
beforeEach(() => { global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { tools: definitions } }) }); });

it("keeps the sandbox unsupported tool off while allowing broker-qualified builtins", async () => {
  const onChange = jest.fn();
  render(<BuiltinToolsPicker value={undefined} onChange={onChange} disabledToolIds={["unsupported_example"]} />);
  const unsupported = await screen.findByRole("switch", { name: "Enable Unsupported Example" });
  expect(unsupported).toBeDisabled();
  expect(unsupported).toHaveAttribute("aria-checked", "false");
  expect(onChange).not.toHaveBeenCalled();
  const fetchTool = screen.getByRole("switch", { name: "Enable Fetch URL" });
  expect(fetchTool).toBeEnabled();
  fireEvent.click(fetchTool);
  expect(onChange).toHaveBeenCalledWith({ fetch_url: { enabled: true } });
});

it("allows disabling a previously saved unsupported tool without allowing reenable", async () => {
  const onChange = jest.fn();
  const { rerender } = render(<BuiltinToolsPicker value={{ unsupported_example: { enabled: true } }} onChange={onChange} disabledToolIds={["unsupported_example"]} />);
  fireEvent.click(await screen.findByRole("switch", { name: "Enable Unsupported Example" }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith({ unsupported_example: { enabled: false } }));
  rerender(<BuiltinToolsPicker value={{ unsupported_example: { enabled: false } }} onChange={onChange} disabledToolIds={["unsupported_example"]} />);
  expect(screen.getByRole("switch", { name: "Enable Unsupported Example" })).toBeDisabled();
});
