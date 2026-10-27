/**
 * @jest-environment jsdom
 */

import {
  applyColorTheme,
  getDefaultAppearancePreferences,
  applyInterfaceShadows,
  normalizeServerAppearancePreferences,
  markAppearanceInteraction,
  mergeUnchangedServerAppearance,
  readCachedAppearancePreferences,
  snapshotAppearanceInteractions,
  type AppearancePreferences,
} from "@/lib/appearance-preferences";

const CURRENT: AppearancePreferences = {
  fontFamily: "inter",
  fontSize: "large",
  gradientTheme: "default",
  theme: "dark",
  shadowsEnabled: true,
  assistantGlassEnabled: true,
  assistantFontScale: "auto",
};

describe("appearance preference hydration",() => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.removeProperty("color-scheme");
  });

  it("defaults to glass on and shadows off", () => {
    expect(getDefaultAppearancePreferences()).toMatchObject({ assistantGlassEnabled: true, shadowsEnabled: false, assistantFontScale: "auto" });
  });

  it("applies explicit themes to the root and clears stale native color schemes",() => {
    document.documentElement.style.colorScheme = "dark";

    applyColorTheme("legacy-light");

    expect(document.documentElement).toHaveAttribute("data-theme","legacy-light");
    expect(document.documentElement.style.colorScheme).toBe("");
    expect(localStorage.getItem("theme")).toBe("legacy-light");
  });

  it("reads the next-themes cache with the other appearance values",() => {
    localStorage.setItem("theme","nord");

    expect(readCachedAppearancePreferences()).toMatchObject({ theme: "nord" });
  });

  it("recognizes the opt-in Legacy Light cache value",() => {
    localStorage.setItem("theme","legacy-light");

    expect(readCachedAppearancePreferences()).toMatchObject({ theme: "legacy-light" });
  });

  it("does not overwrite a field changed after hydration started",() => {
    const snapshot = snapshotAppearanceInteractions();
    markAppearanceInteraction("fontSize");

    expect(mergeUnchangedServerAppearance(
      CURRENT,
      {
        fontFamily: "source-sans",
        fontSize: "small",
        gradientTheme: "ocean",
        theme: "light",
      },
      snapshot,
    )).toEqual({
      fontFamily: "source-sans",
      fontSize: "large",
      gradientTheme: "ocean",
      theme: "light",
      shadowsEnabled: true,
  assistantGlassEnabled: true,
  assistantFontScale: "auto",
    });
  });

  it("persists an explicit shadow opt-out and hydrates false from the account", () => {
    applyInterfaceShadows(false);
    expect(document.documentElement).toHaveAttribute("data-interface-shadows", "off");
    expect(readCachedAppearancePreferences()).toMatchObject({ shadowsEnabled: false });
    expect(mergeUnchangedServerAppearance(CURRENT, normalizeServerAppearancePreferences({ shadows_enabled: false }), snapshotAppearanceInteractions())).toMatchObject({ shadowsEnabled: false });
    expect(normalizeServerAppearancePreferences({ shadows_enabled: "false" })).not.toHaveProperty("shadowsEnabled");
  });

  it("does not overwrite a shadow toggle made while account preferences are loading", () => {
    const snapshot = snapshotAppearanceInteractions();
    markAppearanceInteraction("shadowsEnabled");
    expect(mergeUnchangedServerAppearance({ ...CURRENT, shadowsEnabled: false }, { shadowsEnabled: true }, snapshot)).toMatchObject({ shadowsEnabled: false });
  });
});
