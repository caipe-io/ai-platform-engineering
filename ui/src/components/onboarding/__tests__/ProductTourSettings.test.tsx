import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProductTourSettings } from "../ProductTour";
import { useCaipeTourStore } from "@/store/caipe-tour-store";

jest.mock("next/navigation", () => ({ usePathname: () => "/settings/chat-and-agents", useRouter: () => ({ push: jest.fn() }) }));
beforeEach(() => {
  useCaipeTourStore.getState().reset();
  global.fetch = jest.fn(async (_url, init) => ({ ok: true, json: async () => ({ success: true, data: { state: {}, tours_enabled: init?.method === "PATCH" ? JSON.parse(String(init.body)).enabled : true, enabled_tours: ["workspace", "chat"] } }) })) as jest.Mock;
});

it("turns off the account's tours and disables replay without resetting progress", async () => {
  render(<ProductTourSettings />);
  const control = screen.getByRole("switch", { name: "Enable CAIPE Tour" });
  await waitFor(() => expect(control).toBeEnabled());
  fireEvent.click(control);
  await waitFor(() => expect(control).toHaveAttribute("aria-checked", "false"));
  expect(screen.getByRole("button", { name: "Replay CAIPE Tour" })).toBeDisabled();
  expect(global.fetch).toHaveBeenCalledWith("/api/onboarding/product-tour", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ action: "set_enabled", enabled: false }) }));
});

it("does not claim a failed preference save succeeded", async () => {
  const original = global.fetch;
  global.fetch = jest.fn((url, init) => init?.method === "PATCH" ? Promise.resolve({ ok: false, json: async () => ({ error: "Save unavailable" }) } as Response) : original(url, init));
  render(<ProductTourSettings />);
  const control = screen.getByRole("switch", { name: "Enable CAIPE Tour" });
  await waitFor(() => expect(control).toBeEnabled()); fireEvent.click(control);
  expect(await screen.findByRole("alert")).toHaveTextContent("Save unavailable");
  expect(control).toHaveAttribute("aria-checked", "true");
});
