/**
 * @jest-environment jsdom
 */

import {
  applyColorTheme,
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
};

describe("appearance preference hydration",() => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.removeProperty("color-scheme");
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
    });
  });
});
