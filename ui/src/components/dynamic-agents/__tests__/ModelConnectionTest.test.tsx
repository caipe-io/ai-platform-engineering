import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelConnectionTest } from "../ModelConnectionTest";

it("keeps row actions available while opening connection diagnostics", async () => {
  const user = userEvent.setup();
  const openEditor = jest.fn();
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      success: false,
      category: "authentication",
      message: "Provider rejected the credential",
      elapsed_ms: 42,
      status_code: 401,
    }),
  })) as jest.Mock;
  render(
    <div onClick={openEditor}>
      <ModelConnectionTest compact request={{ model_id: "example-model" }} />
    </div>,
  );
  await user.click(screen.getByRole("button", { name: "Test Connection" }));
  const details = await screen.findByRole("button", {
    name: /Connection result: Connection failed/,
  });
  expect(
    screen.queryByText("Provider rejected the credential"),
  ).not.toBeInTheDocument();
  await user.click(details);
  expect(
    await screen.findByText("Provider rejected the credential"),
  ).toBeInTheDocument();
  expect(screen.getByText("HTTP 401")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Test Connection" })).toBeEnabled();
  expect(openEditor).not.toHaveBeenCalled();
});


it.each([false, true])("ignores an obsolete request result and callback (failed=%s) while the new configuration is being tested", async failed => {
  const user = userEvent.setup();
  let finishFirst!: (value: unknown) => void;
  let finishSecond!: (value: unknown) => void;
  const first = new Promise(resolve => { finishFirst = resolve; });
  const second = new Promise(resolve => { finishSecond = resolve; });
  global.fetch = jest.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  const onSuccess = jest.fn();
  const { rerender } = render(<ModelConnectionTest request={{ draft: { endpoint: "https://first.example.test" } }} onSuccess={onSuccess} />);
  await user.click(screen.getByRole("button", { name: "Test Connection" }));
  rerender(<ModelConnectionTest request={{ draft: { endpoint: "https://second.example.test" } }} onSuccess={onSuccess} />);
  await user.click(screen.getByRole("button", { name: "Test Connection" }));
  const response = { ok: true, json: async () => ({ success: true, data: { success: true, category: "success", message: "Example", elapsed_ms: 1 } }) };
  await act(async () => { finishFirst(failed ? { ok: false, json: async () => ({ error: "Obsolete failure" }) } : response); });
  expect(onSuccess).not.toHaveBeenCalled();
  expect(screen.queryByText(/Connected ·/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Testing…" })).toBeDisabled();
  await act(async () => { finishSecond(response); });
  expect(await screen.findByText(/Connected ·/)).toBeInTheDocument();
  expect(onSuccess).toHaveBeenCalledTimes(1);
});
