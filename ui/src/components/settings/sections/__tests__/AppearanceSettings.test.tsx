import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AppearanceSettings } from "../AppearanceSettings";

const mockUpdate = jest.fn().mockResolvedValue({});
jest.mock("@/lib/api-client", () => ({ apiClient: {
  getSettings: async () => ({ preferences: {} }),
  updatePreferences: (...args: unknown[]) => mockUpdate(...args),
} }));
jest.mock("@/components/theme-provider", () => ({ useTheme: () => ({ setTheme: jest.fn() }) }));

it("keeps the assistant opaque and saves its text size preference", async () => {
  localStorage.clear();
  render(<AppearanceSettings />);
  expect(screen.queryByRole("switch", { name: "Glass assistant appearance" })).not.toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Show interface shadows" })).toHaveAttribute("aria-checked", "false");
  fireEvent.change(screen.getByLabelText("Chat text size"), { target: { value: "large" } });
  await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith({ assistant_font_scale: "large" }));
  expect(localStorage.getItem("agentic-app-assistant-font-scale")).toBe("large");
});
