import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CaipeTourSettings } from "../CaipeTourSettings";
import { useCaipeTourStore } from "@/store/caipe-tour-store";

function installMock(fail = false) {
  let platformEnabled = true;
  global.fetch = jest.fn(async (url, init) => {
    const patch = init?.method === "PATCH";
    const policy = patch ? JSON.parse(String(init.body)).caipe_tour : null;
    if (patch && !fail && typeof policy.enabled === "boolean") platformEnabled = policy.enabled;
    return {
      ok: !(fail && patch),
      json: async () => patch
        ? fail ? { error: "Save unavailable" } : { success: true, data: { caipe_tour: policy } }
        : String(url).includes("platform-config")
          ? { success: true, data: { caipe_tour: { enabled: platformEnabled, enabled_tours: ["workspace", "chat"] } } }
          : { success: true, data: { state: {}, platform_enabled: platformEnabled, enabled_tours: ["chat"], tours_enabled: true } },
    };
  }) as jest.Mock;
}
beforeEach(() => { useCaipeTourStore.getState().reset(); installMock(); });

it("loads the saved checks and saves only the selected tour IDs", async () => {
  render(<CaipeTourSettings />);
  const workspace = await screen.findByRole("checkbox", { name: /Workspace tour/ });
  await waitFor(() => expect(workspace).toBeEnabled());
  expect(screen.getAllByRole("checkbox").map((checkbox) => checkbox.getAttribute("aria-label") || checkbox.closest("label")?.textContent)).toEqual([
    expect.stringMatching(/^Add a model/),
    expect.stringMatching(/^Add an agent/),
    expect.stringMatching(/^Add an MCP server/),
    expect.stringMatching(/^Chat with an agent/),
    expect.stringMatching(/^Connect credentials/),
    expect.stringMatching(/^Workspace tour/),
  ]);
  expect(workspace).toBeChecked();
  expect(screen.getByRole("checkbox", { name: /Chat with an agent/ })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: /Add a model/ })).not.toBeChecked();
  fireEvent.click(workspace);
  fireEvent.click(screen.getByRole("button", { name: "Save tours" }));
  await screen.findByText("CAIPE Tour availability saved.");
  expect(global.fetch).toHaveBeenCalledWith("/api/admin/platform-config", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ caipe_tour: { enabled_tours: ["chat"] } }) }));
  expect(useCaipeTourStore.getState().enabledTours).toEqual(["chat"]);
});

it("can uncheck all tours", async () => {
  render(<CaipeTourSettings />);
  await waitFor(() => expect(screen.getByRole("checkbox", { name: /Workspace tour/ })).toBeEnabled());
  fireEvent.click(screen.getByRole("checkbox", { name: /Workspace tour/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Chat with an agent/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save tours" }));
  await screen.findByText("CAIPE Tour availability saved.");
  expect(global.fetch).toHaveBeenCalledWith("/api/admin/platform-config", expect.objectContaining({ body: JSON.stringify({ caipe_tour: { enabled_tours: [] } }) }));
});

it("does not allow changes in View as", async () => {
  render(<CaipeTourSettings readOnly />);
  await waitFor(() => expect(screen.queryByText(/Loading CAIPE Tour policy/)).not.toBeInTheDocument());
  for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).toBeDisabled();
  expect(screen.getByRole("switch", { name: "Enable CAIPE Tour" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save tours" })).toBeDisabled();
});

it("keeps edits available to retry after a failed save", async () => {
  installMock(true); render(<CaipeTourSettings />);
  await waitFor(() => expect(screen.getByRole("checkbox", { name: /Workspace tour/ })).toBeEnabled());
  fireEvent.click(screen.getByRole("checkbox", { name: /Workspace tour/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save tours" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Save unavailable");
  expect(screen.getByRole("button", { name: "Save tours" })).toBeEnabled();
  expect(screen.queryByText("CAIPE Tour availability saved.")).not.toBeInTheDocument();
});

it("switches off immediately without saving or clearing draft tour selections", async () => {
  render(<CaipeTourSettings />);
  const control = screen.getByRole("switch", { name: "Enable CAIPE Tour" });
  await waitFor(() => expect(control).toBeEnabled());
  const workspace = screen.getByRole("checkbox", { name: /Workspace tour/ });
  fireEvent.click(workspace);
  fireEvent.click(control);
  await screen.findByText("CAIPE Tour is off. Your tour selections are kept.");
  expect(control).toHaveAttribute("aria-checked", "false");
  expect(workspace).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: /Chat with an agent/ })).toBeChecked();
  expect(screen.getByRole("button", { name: "Save tours" })).toBeEnabled();
  expect(global.fetch).toHaveBeenCalledWith("/api/admin/platform-config", expect.objectContaining({ body: JSON.stringify({ caipe_tour: { enabled: false } }) }));
  expect(useCaipeTourStore.getState().platformEnabled).toBe(false);
  fireEvent.click(control);
  await screen.findByText("CAIPE Tour is on.");
  expect(control).toHaveAttribute("aria-checked", "true");
  expect(workspace).not.toBeChecked();
});

it("retains the switch state if the runtime update fails", async () => {
  installMock(true); render(<CaipeTourSettings />);
  const control = screen.getByRole("switch", { name: "Enable CAIPE Tour" });
  await waitFor(() => expect(control).toBeEnabled());
  fireEvent.click(control);
  expect(await screen.findByRole("alert")).toHaveTextContent("Save unavailable");
  expect(control).toHaveAttribute("aria-checked", "true");
});
