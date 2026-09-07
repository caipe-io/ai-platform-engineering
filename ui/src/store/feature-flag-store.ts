import { apiClient } from "@/lib/api-client";
import { create } from "zustand";

const STORAGE_KEY = "caipe-feature-flags";

export type FeatureFlagIcon = "Brain" | "Bug" | "Eye" | "ArrowDownToLine" | "Clock";
export type FeatureFlagCategory = "ai" | "chat" | "developer";

export const CATEGORY_LABELS: Record<FeatureFlagCategory, string> = {
  ai: "AI & Memory",
  chat: "Chat Behavior",
  developer: "Developer",
};

export interface FeatureFlag {
  id: string;
  label: string;
  description: string;
  /** Longer explanation shown in the info tooltip */
  detail: string;
  icon: FeatureFlagIcon;
  category: FeatureFlagCategory;
  defaultValue: boolean;
  /** MongoDB preferences field name used for server sync */
  preferencesKey: string;
}

export const FEATURE_FLAGS: FeatureFlag[] = [
  {
    id: "showThinking",
    label: "Show Thinking",
    description: "Expand the raw stream panel by default",
    detail:
      "Controls whether the \"Thinking...\" panel is expanded or collapsed when the assistant starts streaming a response. You can always toggle it per-message.",
    icon: "Eye",
    category: "chat",
    defaultValue: true,
    preferencesKey: "show_thinking_enabled",
  },
  {
    id: "autoScroll",
    label: "Auto-Scroll",
    description: "Scroll to newest message automatically",
    detail:
      "When enabled, the chat view scrolls to the bottom as new messages arrive and during streaming. Disable to keep your scroll position while reading older messages.",
    icon: "ArrowDownToLine",
    category: "chat",
    defaultValue: true,
    preferencesKey: "auto_scroll_enabled",
  },
  {
    id: "showTimestamps",
    label: "Show Timestamps",
    description: "Display time next to each message",
    detail:
      "Shows a small timestamp (e.g. 2:34 PM) next to each message in the chat. Useful for tracking response times and reviewing conversation history.",
    icon: "Clock",
    category: "chat",
    defaultValue: false,
    preferencesKey: "show_timestamps_enabled",
  },
  {
    id: "debug",
    label: "Debug Mode",
    description: "Verbose logging in browser console",
    detail:
      "Enables detailed diagnostic output in the browser developer console to help troubleshoot agent interactions and streaming issues.",
    icon: "Bug",
    category: "developer",
    defaultValue: false,
    preferencesKey: "debug_mode_enabled",
  },
];

interface FeatureFlagState {
  flags: Record<string, boolean>;
  initialized: boolean;
  touched: Record<string,boolean>;

  initialize: () => void;
  setEnabled: (id: string,value: boolean) => void;
  toggle: (id: string) => void;
  isEnabled: (id: string) => boolean;
}

function getDefaults(): Record<string, boolean> {
  const defaults: Record<string, boolean> = {};
  for (const flag of FEATURE_FLAGS) {
    defaults[flag.id] = flag.defaultValue;
  }
  return defaults;
}

function readFromLocalStorage(): Record<string, boolean> {
  if (typeof window === "undefined") return getDefaults();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaults();
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    const merged = getDefaults();
    for (const flag of FEATURE_FLAGS) {
      if (typeof parsed[flag.id] === "boolean") {
        merged[flag.id] = parsed[flag.id];
      }
    }
    return merged;
  } catch {
    return getDefaults();
  }
}

function writeToLocalStorage(flags: Record<string, boolean>): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
}

export async function persistFeatureFlag(id: string,value: boolean): Promise<void> {
  const flag = FEATURE_FLAGS.find((candidate) => candidate.id === id);
  if (!flag) throw new Error(`Unknown preference: ${id}`);
  await apiClient.updatePreferences({ [flag.preferencesKey]: String(value) });
}

export const useFeatureFlagStore = create<FeatureFlagState>((set, get) => ({
  flags: getDefaults(),
  initialized: false,
  touched: {},

  initialize: () => {
    if (get().initialized) return;
    const flags = readFromLocalStorage();
    set({ flags, initialized: true });

    apiClient
      .getSettings()
      .then((settings) => {
        if (!settings?.preferences) return;
        const prefs = settings.preferences;
        const updated = { ...get().flags };
        const touched = get().touched;
        let changed = false;
        for (const flag of FEATURE_FLAGS) {
          if (touched[flag.id]) continue;
          const serverVal = prefs[flag.preferencesKey as keyof typeof prefs];
          if (typeof serverVal === "string") {
            const boolVal = serverVal === "true";
            if (updated[flag.id] !== boolVal) {
              updated[flag.id] = boolVal;
              changed = true;
            }
          }
        }
        if (changed) {
          writeToLocalStorage(updated);
          set({ flags: updated });
        }
      })
      .catch((error: unknown) => {
        console.warn("[feature-flags] Account preferences could not be loaded",error);
      });
  },

  setEnabled: (id: string,value: boolean) => {
    const current = get().flags;
    const next = { ...current,[id]: value };
    writeToLocalStorage(next);
    set((state) => ({ flags: next,touched: { ...state.touched,[id]: true } }));
  },

  toggle: (id: string) => {
    const current = get().flags;
    const value = !current[id];
    const next = { ...current,[id]: value };
    writeToLocalStorage(next);
    set((state) => ({ flags: next,touched: { ...state.touched,[id]: true } }));
    void persistFeatureFlag(id,value).catch((error: unknown) => {
      console.warn(`[feature-flags] Could not sync ${id}`,error);
    });
  },

  isEnabled: (id: string) => {
    const val = get().flags[id];
    if (typeof val === "boolean") return val;
    const flag = FEATURE_FLAGS.find((f) => f.id === id);
    return flag?.defaultValue ?? false;
  },
}));

/**
 * Read a feature flag outside of React components.
 *
 * Prefers the Zustand store when initialized, otherwise falls back to
 * localStorage so it works before React hydration (e.g. inside the
 * non-React streaming/client setup).
 */
export function isFeatureEnabled(id: string): boolean {
  const store = useFeatureFlagStore.getState();
  if (store.initialized) return store.isEnabled(id);
  const flags = readFromLocalStorage();
  return flags[id] ?? getDefaults()[id] ?? false;
}
