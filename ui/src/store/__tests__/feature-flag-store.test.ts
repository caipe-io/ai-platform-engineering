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

import { FEATURE_FLAGS,persistFeatureFlag,useFeatureFlagStore } from "@/store/feature-flag-store";

function defaultFlags(): Record<string,boolean> {
  return Object.fromEntries(FEATURE_FLAGS.map((flag) => [flag.id,flag.defaultValue]));
}

describe("feature flag preference hydration",() => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
    useFeatureFlagStore.setState({
      flags: defaultFlags(),
      initialized: false,
      touched: {},
    });
  });

  it("hydrates untouched preferences from the account",async () => {
    getSettingsMock.mockResolvedValue({
      preferences: { show_timestamps_enabled: "true" },
    });

    act(() => useFeatureFlagStore.getState().initialize());

    await waitFor(() => {
      expect(useFeatureFlagStore.getState().flags.showTimestamps).toBe(true);
    });
  });

  it("does not let late hydration overwrite a newer interaction",async () => {
    let resolveSettings!: (value: unknown) => void;
    getSettingsMock.mockReturnValue(new Promise((resolve) => {
      resolveSettings = resolve;
    }));

    act(() => useFeatureFlagStore.getState().initialize());
    act(() => useFeatureFlagStore.getState().setEnabled("showThinking",false));
    await act(async () => {
      resolveSettings({ preferences: { show_thinking_enabled: "true" } });
      await Promise.resolve();
    });

    expect(getSettingsMock).toHaveBeenCalledTimes(1);
    expect(useFeatureFlagStore.getState().flags.showThinking).toBe(false);
  });

  it("persists only the selected preference field",async () => {
    updatePreferencesMock.mockResolvedValue({});

    await persistFeatureFlag("autoScroll",false);

    expect(updatePreferencesMock).toHaveBeenCalledWith({ auto_scroll_enabled: "false" });
  });
});
