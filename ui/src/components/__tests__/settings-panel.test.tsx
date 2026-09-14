/**
 * @jest-environment jsdom
 */

import { act,render,screen,waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";

const mockGetSettings = jest.fn();
const mockSetTheme = jest.fn();
let mockSetThemeVersion: (theme: string) => void = mockSetTheme;
let mockTheme = "dark";
let mockConfig: Record<string,string> = {};

jest.mock("@/components/theme-provider",() => ({
  useTheme: () => ({ theme: mockTheme,setTheme: mockSetThemeVersion }),
}));

jest.mock("@/lib/api-client",() => ({
  apiClient: { getSettings: (...args: unknown[]) => mockGetSettings(...args) },
}));

jest.mock("@/lib/config",() => ({
  getConfig: (key: string) => mockConfig[key],
}));

import { SettingsPanel } from "../settings-panel";

describe("SettingsPanel",() => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetThemeVersion = mockSetTheme;
    localStorage.clear();
    document.body.removeAttribute("data-font-size");
    document.body.removeAttribute("data-font-family");
    document.documentElement.removeAttribute("data-gradient-theme");
    document.documentElement.style.removeProperty("--primary");
    document.documentElement.style.removeProperty("--ring");
    document.documentElement.style.removeProperty("--gradient-start");
    document.documentElement.style.removeProperty("--gradient-mid");
    document.documentElement.style.removeProperty("--gradient-end");
    mockTheme = "dark";
    mockConfig = {
      defaultFontSize: "medium",
      defaultFontFamily: "inter",
      defaultTheme: "dark",
      defaultGradientTheme: "default",
    };
    mockGetSettings.mockResolvedValue({
      preferences: {
        font_size: "medium",
        font_family: "inter",
        gradient_theme: "default",
        theme: "dark",
      },
    });
  });

  it("links directly to Appearance settings",async () => {
    await act(async () => {
      render(<SettingsPanel />);
    });

    const link = screen.getByRole("link",{ name: "Appearance settings" });
    expect(link).toHaveTextContent("Dark");
    expect(link).toHaveAttribute("href","/settings/appearance");
  });

  it("uses a stable label in server output before browser preferences hydrate",() => {
    const html = renderToString(<SettingsPanel />);

    expect(html).toContain("Appearance");
    expect(html).not.toContain(">Dark<");
  });

  it("hydrates cached appearance immediately",async () => {
    localStorage.setItem("caipe-font-size","large");
    localStorage.setItem("caipe-font-family","ibm-plex");
    localStorage.setItem("caipe-gradient-theme","ocean");
    mockGetSettings.mockRejectedValue(new Error("offline"));

    await act(async () => {
      render(<SettingsPanel />);
    });

    expect(document.body).toHaveAttribute("data-font-size","large");
    expect(document.body).toHaveAttribute("data-font-family","ibm-plex");
    expect(document.documentElement).toHaveAttribute("data-gradient-theme","ocean");
  });

  it("overrides the device cache with account preferences",async () => {
    localStorage.setItem("caipe-font-size","small");
    mockGetSettings.mockResolvedValue({
      preferences: {
        font_size: "x-large",
        font_family: "source-sans",
        gradient_theme: "sunset",
        theme: "nord",
      },
    });

    render(<SettingsPanel />);

    await waitFor(() => {
      expect(document.body).toHaveAttribute("data-font-size","x-large");
      expect(document.body).toHaveAttribute("data-font-family","source-sans");
      expect(document.documentElement).toHaveAttribute("data-gradient-theme","sunset");
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe("30 80% 55%");
      expect(document.documentElement.style.getPropertyValue("--ring")).toBe("30 80% 55%");
      expect(mockSetTheme).toHaveBeenCalledWith("nord");
    });
  });

  it("does not rehydrate when next-themes changes the setter identity",async () => {
    const { rerender } = render(<SettingsPanel />);

    await waitFor(() => expect(mockGetSettings).toHaveBeenCalledTimes(1));

    mockTheme = "legacy-light";
    mockSetThemeVersion = jest.fn();
    rerender(<SettingsPanel />);

    expect(screen.getByRole("link",{ name: "Appearance settings" })).toHaveTextContent("Legacy Light");
    expect(mockGetSettings).toHaveBeenCalledTimes(1);
  });
});
