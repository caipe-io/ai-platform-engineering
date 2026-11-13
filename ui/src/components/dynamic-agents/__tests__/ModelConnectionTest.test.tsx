import { render, screen } from "@testing-library/react";
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
