/**
 * @jest-environment jsdom
 */

import { act,waitFor } from "@testing-library/react";

const getSettingsMock = jest.fn();
const updatePreferencesMock = jest.fn();

jest.mock("@/lib/api-client",() => ({
  apiClient: {
    getSettings: (...args: unknown[]) => getSettingsMock(...args),
    updatePreferences: (...args: unknown[]) => updatePreferencesMock(...args),
  },
}));

let mockStorageMode = "mongodb";
jest.mock("@/lib/storage-config",() => ({
  getStorageMode: () => mockStorageMode,
}));

import {
  DEFAULT_HOME_WIDGETS,
  HOME_WIDGET_DEFINITIONS,
  HOME_WIDGETS_SCHEMA_VERSION,
  getHomeWidgetDefinition,
  useHomeWidgetsStore,
} from "@/store/home-widgets-store";

describe("home widgets store",() => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
    mockStorageMode = "mongodb";
    useHomeWidgetsStore.setState({
      widgets: DEFAULT_HOME_WIDGETS,
      initialized: false,
      touched: false,
    });
  });

  it("starts with the composer and quick start widgets enabled",() => {
    expect(useHomeWidgetsStore.getState().widgets).toEqual(["heroComposer", "quickStart"]);
    expect(useHomeWidgetsStore.getState().isEnabled("heroComposer")).toBe(true);
  });

  it("defines primary widgets as full width and dashboard widgets as half width",() => {
    expect(getHomeWidgetDefinition("heroComposer")?.width).toBe("full");
    expect(getHomeWidgetDefinition("quickStart")?.width).toBe("full");
    expect(getHomeWidgetDefinition("recentChats")?.width).toBe("half");
    expect(getHomeWidgetDefinition("insights")?.width).toBe("half");
    expect(getHomeWidgetDefinition("sharedConversations")?.width).toBe("half");
  });

  it("addWidget enables a widget and persists it to localStorage immediately",() => {
    act(() => useHomeWidgetsStore.getState().addWidget("recentChats"));

    expect(useHomeWidgetsStore.getState().widgets).toEqual([
      "heroComposer",
      "quickStart",
      "recentChats",
    ]);
    expect(JSON.parse(localStorage.getItem("caipe-home-widgets") || "[]")).toEqual([
      "heroComposer",
      "quickStart",
      "recentChats",
    ]);
    expect(localStorage.getItem("caipe-home-widgets-version")).toBe(
      String(HOME_WIDGETS_SCHEMA_VERSION),
    );
  });

  it("addWidget is idempotent for an already-enabled widget",() => {
    act(() => useHomeWidgetsStore.getState().addWidget("recentChats"));
    act(() => useHomeWidgetsStore.getState().addWidget("recentChats"));

    expect(useHomeWidgetsStore.getState().widgets).toEqual([
      "heroComposer",
      "quickStart",
      "recentChats",
    ]);
  });

  it("removeWidget disables a widget",() => {
    act(() => useHomeWidgetsStore.getState().addWidget("recentChats"));
    act(() => useHomeWidgetsStore.getState().removeWidget("recentChats"));

    expect(useHomeWidgetsStore.getState().widgets).toEqual(DEFAULT_HOME_WIDGETS);
    expect(JSON.parse(localStorage.getItem("caipe-home-widgets") || "[]")).toEqual(
      DEFAULT_HOME_WIDGETS,
    );
  });

  it("fires a best-effort sync to the server on add/remove",() => {
    updatePreferencesMock.mockResolvedValue({});
    act(() => useHomeWidgetsStore.getState().addWidget("shortcuts"));

    expect(updatePreferencesMock).toHaveBeenCalledWith({
      home_widgets: ["heroComposer", "quickStart", "shortcuts"],
      home_widgets_version: HOME_WIDGETS_SCHEMA_VERSION,
    });
  });

  it("reorderWidgets updates the order and persists it",() => {
    useHomeWidgetsStore.setState({ widgets: ["recentChats", "shortcuts"] });

    act(() => useHomeWidgetsStore.getState().reorderWidgets(["shortcuts","recentChats"]));

    expect(useHomeWidgetsStore.getState().widgets).toEqual(["shortcuts","recentChats"]);
    expect(JSON.parse(localStorage.getItem("caipe-home-widgets") || "[]")).toEqual(["shortcuts","recentChats"]);
  });

  it("reorderWidgets ignores an order that isn't a permutation of the current widgets",() => {
    useHomeWidgetsStore.setState({ widgets: ["recentChats", "shortcuts"] });

    act(() => useHomeWidgetsStore.getState().reorderWidgets(["shortcuts","recentChats","insights"]));

    expect(useHomeWidgetsStore.getState().widgets).toEqual(["recentChats","shortcuts"]);
  });

  it("availableToAdd excludes already-enabled widgets",() => {
    act(() => useHomeWidgetsStore.getState().addWidget("recentChats"));
    act(() => useHomeWidgetsStore.getState().removeWidget("heroComposer"));

    const available = useHomeWidgetsStore.getState().availableToAdd();
    expect(available.some((w) => w.id === "recentChats")).toBe(false);
    expect(available.some((w) => w.id === "shortcuts")).toBe(true);
    expect(available.some((w) => w.id === "heroComposer")).toBe(true);
  });

  it("availableToAdd excludes Mongo-only widgets in localStorage mode",() => {
    mockStorageMode = "localStorage";
    const available = useHomeWidgetsStore.getState().availableToAdd();
    const mongoOnlyIds = HOME_WIDGET_DEFINITIONS.filter((w) => w.requiresMongo).map((w) => w.id);

    expect(mongoOnlyIds.length).toBeGreaterThan(0);
    for (const id of mongoOnlyIds) {
      expect(available.some((w) => w.id === id)).toBe(false);
    }
  });

  it("initialize hydrates from localStorage first, then merges untouched server state",async () => {
    localStorage.setItem("caipe-home-widgets", JSON.stringify(["shortcuts"]));
    getSettingsMock.mockResolvedValue({
      preferences: { home_widgets: ["shortcuts", "recentChats"] },
    });

    act(() => useHomeWidgetsStore.getState().initialize());

    // Local value is applied synchronously, before the server round-trip resolves.
    expect(useHomeWidgetsStore.getState().widgets).toEqual([
      "heroComposer",
      "quickStart",
      "shortcuts",
    ]);

    await waitFor(() => {
      expect(useHomeWidgetsStore.getState().widgets).toEqual([
        "heroComposer",
        "quickStart",
        "shortcuts",
        "recentChats",
      ]);
    });
  });

  it("filters the retired welcome banner widget from saved preferences",async () => {
    localStorage.setItem("caipe-home-widgets", JSON.stringify(["welcomeBanner", "shortcuts"]));
    getSettingsMock.mockResolvedValue({
      preferences: { home_widgets: ["welcomeBanner", "recentChats"] },
    });

    act(() => useHomeWidgetsStore.getState().initialize());

    expect(useHomeWidgetsStore.getState().widgets).toEqual([
      "heroComposer",
      "quickStart",
      "shortcuts",
    ]);
    await waitFor(() => {
      expect(useHomeWidgetsStore.getState().widgets).toEqual([
        "heroComposer",
        "quickStart",
        "recentChats",
      ]);
    });
  });

  it("respects an explicitly empty current-version widget layout",async () => {
    localStorage.setItem("caipe-home-widgets", JSON.stringify([]));
    localStorage.setItem("caipe-home-widgets-version", String(HOME_WIDGETS_SCHEMA_VERSION));
    getSettingsMock.mockResolvedValue({
      preferences: { home_widgets: [], home_widgets_version: HOME_WIDGETS_SCHEMA_VERSION },
    });

    act(() => useHomeWidgetsStore.getState().initialize());

    expect(useHomeWidgetsStore.getState().widgets).toEqual([]);
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledTimes(1));
    expect(useHomeWidgetsStore.getState().widgets).toEqual([]);
  });

  it("migrates legacy server widget preferences and records the schema version",async () => {
    getSettingsMock.mockResolvedValue({
      preferences: { home_widgets: ["shortcuts"] },
    });
    updatePreferencesMock.mockResolvedValue({});

    act(() => useHomeWidgetsStore.getState().initialize());

    await waitFor(() => {
      expect(updatePreferencesMock).toHaveBeenCalledWith({
        home_widgets: ["heroComposer", "quickStart", "shortcuts"],
        home_widgets_version: HOME_WIDGETS_SCHEMA_VERSION,
      });
    });
  });

  it("does not let late hydration overwrite a newer interaction",async () => {
    let resolveSettings!: (value: unknown) => void;
    getSettingsMock.mockReturnValue(new Promise((resolve) => {
      resolveSettings = resolve;
    }));

    act(() => useHomeWidgetsStore.getState().initialize());
    act(() => useHomeWidgetsStore.getState().addWidget("recentChats"));
    await act(async () => {
      resolveSettings({ preferences: { home_widgets: ["shortcuts"] } });
      await Promise.resolve();
    });

    expect(getSettingsMock).toHaveBeenCalledTimes(1);
    expect(useHomeWidgetsStore.getState().widgets).toEqual([
      "heroComposer",
      "quickStart",
      "recentChats",
    ]);
  });

  describe("Classic Home preference migration",() => {
    it("removes the retired local Classic Home preference",() => {
      localStorage.setItem("caipe-home-experience", "classic");
      getSettingsMock.mockReturnValue(new Promise(() => {}));

      act(() => useHomeWidgetsStore.getState().initialize());

      expect(localStorage.getItem("caipe-home-experience")).toBeNull();
    });

    it("migrates a saved server preference to the customizable Home",async () => {
      getSettingsMock.mockResolvedValue({ preferences: { home_experience: "classic" } });
      updatePreferencesMock.mockResolvedValue({});

      act(() => useHomeWidgetsStore.getState().initialize());

      await waitFor(() => {
        expect(updatePreferencesMock).toHaveBeenCalledWith({ home_experience: "new" });
      });
    });
  });
});
