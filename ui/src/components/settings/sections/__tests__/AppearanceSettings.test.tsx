import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AppearanceSettings } from "../AppearanceSettings";

const mockUpdate = jest.fn().mockResolvedValue({});
jest.mock("@/lib/api-client", () => ({ apiClient: {
  getSettings: async () => ({ preferences: {} }),
  updatePreferences: (...args: unknown[]) => mockUpdate(...args),
} }));
jest.mock("@/components/theme-provider", () => ({ useTheme: () => ({ setTheme: jest.fn() }) }));

it("saves assistant display options as user preferences with glass on and shadows off by default", async () => {
  localStorage.clear();
  render(<AppearanceSettings />);
  const glass = await screen.findByRole("switch", { name: "Glass assistant appearance" });
  expect(glass).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("switch", { name: "Show interface shadows" })).toHaveAttribute("aria-checked", "false");
  fireEvent.click(glass);
  fireEvent.change(screen.getByLabelText("Chat text size"), { target: { value: "large" } });
  await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith({ assistant_glass_enabled: false }));
  await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith({ assistant_font_scale: "large" }));
  expect(localStorage.getItem("agentic-app-assistant-glass")).toBe("false");
  expect(localStorage.getItem("agentic-app-assistant-font-scale")).toBe("large");
});
