import { apiClient } from "@/lib/api-client";
import { getStorageMode } from "@/lib/storage-config";
import { create } from "zustand";

const STORAGE_KEY = "caipe-home-widgets";
const STORAGE_VERSION_KEY = "caipe-home-widgets-version";
const LEGACY_EXPERIENCE_STORAGE_KEY = "caipe-home-experience";

export const HOME_WIDGETS_SCHEMA_VERSION = 2;
export const DEFAULT_HOME_WIDGETS = ["heroComposer", "quickStart"];

export interface HomeWidgetDefinition {
  id: string;
  label: string;
  /** Controls the widget's width in the responsive customizable Home grid. */
  width: "full" | "half";
  /** Only offered/rendered when the app is running against MongoDB. */
  requiresMongo?: boolean;
}

export const HOME_WIDGET_DEFINITIONS: HomeWidgetDefinition[] = [
  { id: "heroComposer", label: "Ask CAIPE", width: "full" },
  { id: "quickStart", label: "Quick Start", width: "full" },
  { id: "shortcuts", label: "Shortcuts", width: "full" },
  { id: "recentChats", label: "Recent Chats", width: "half" },
  { id: "insights", label: "Your Insights", width: "half", requiresMongo: true },
  {
    id: "sharedConversations",
    label: "Shared Conversations",
    width: "half",
    requiresMongo: true,
  },
];

export function getHomeWidgetDefinition(id: string): HomeWidgetDefinition | undefined {
  return HOME_WIDGET_DEFINITIONS.find((widget) => widget.id === id);
}

function normalizeWidgetIds(widgets: unknown[]): string[] {
  const validIds = new Set(HOME_WIDGET_DEFINITIONS.map((widget) => widget.id));
  return widgets.filter(
    (id, index): id is string =>
      typeof id === "string" && validIds.has(id) && widgets.indexOf(id) === index,
  );
}

function migrateWidgetIds(widgets: unknown[], version: number | undefined): string[] {
  const normalized = normalizeWidgetIds(widgets);
  if (version !== undefined && version >= HOME_WIDGETS_SCHEMA_VERSION) return normalized;
  return [...DEFAULT_HOME_WIDGETS, ...normalized.filter((id) => !DEFAULT_HOME_WIDGETS.includes(id))];
}

interface StoredWidgetState {
  widgets: string[];
  version: number | undefined;
  hadSavedWidgets: boolean;
}

function readFromLocalStorage(): StoredWidgetState {
  if (typeof window === "undefined") {
    return { widgets: DEFAULT_HOME_WIDGETS, version: undefined, hadSavedWidgets: false };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const storedVersion = Number(localStorage.getItem(STORAGE_VERSION_KEY));
    const version = Number.isFinite(storedVersion) && storedVersion > 0 ? storedVersion : undefined;
    if (!raw) {
      return { widgets: DEFAULT_HOME_WIDGETS, version, hadSavedWidgets: false };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return { widgets: DEFAULT_HOME_WIDGETS, version, hadSavedWidgets: false };
    }
    return {
      widgets: migrateWidgetIds(parsed, version),
      version,
      hadSavedWidgets: true,
    };
  } catch {
    return { widgets: DEFAULT_HOME_WIDGETS, version: undefined, hadSavedWidgets: false };
  }
}

function writeToLocalStorage(widgets: string[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets));
  localStorage.setItem(STORAGE_VERSION_KEY, String(HOME_WIDGETS_SCHEMA_VERSION));
}

function clearLegacyExperiencePreference(): boolean {
  if (typeof window === "undefined") return false;
  const wasClassic = localStorage.getItem(LEGACY_EXPERIENCE_STORAGE_KEY) === "classic";
  localStorage.removeItem(LEGACY_EXPERIENCE_STORAGE_KEY);
  return wasClassic;
}

async function persistHomeWidgets(widgets: string[]): Promise<void> {
  await apiClient.updatePreferences({
    home_widgets: widgets,
    home_widgets_version: HOME_WIDGETS_SCHEMA_VERSION,
  });
}

async function retireClassicHomePreference(): Promise<void> {
  await apiClient.updatePreferences({ home_experience: "new" });
}

interface HomeWidgetsState {
  widgets: string[];
  initialized: boolean;
  touched: boolean;

  initialize: () => void;
  addWidget: (id: string) => void;
  removeWidget: (id: string) => void;
  reorderWidgets: (order: string[]) => void;
  isEnabled: (id: string) => boolean;
  availableToAdd: () => HomeWidgetDefinition[];
}

export const useHomeWidgetsStore = create<HomeWidgetsState>((set, get) => ({
  widgets: DEFAULT_HOME_WIDGETS,
  initialized: false,
  touched: false,

  initialize: () => {
    if (get().initialized) return;
    const localState = readFromLocalStorage();
    const hadLegacyClassicPreference = clearLegacyExperiencePreference();
    set({ widgets: localState.widgets, initialized: true });

    apiClient
      .getSettings()
      .then((settings) => {
        if (get().touched) return;
        const prefs = settings?.preferences;

        const serverWidgets = prefs?.home_widgets;
        if (Array.isArray(serverWidgets)) {
          const serverVersion = prefs?.home_widgets_version;
          const migrated = migrateWidgetIds(serverWidgets, serverVersion);
          writeToLocalStorage(migrated);
          set({ widgets: migrated });
          if (serverVersion === undefined || serverVersion < HOME_WIDGETS_SCHEMA_VERSION) {
            void persistHomeWidgets(migrated).catch((error: unknown) => {
              console.warn("[home-widgets] Could not sync migrated widget preferences", error);
            });
          }
        } else if (
          localState.hadSavedWidgets &&
          (localState.version === undefined || localState.version < HOME_WIDGETS_SCHEMA_VERSION)
        ) {
          writeToLocalStorage(localState.widgets);
          void persistHomeWidgets(localState.widgets).catch((error: unknown) => {
            console.warn("[home-widgets] Could not sync migrated local widget preferences", error);
          });
        }

        if (hadLegacyClassicPreference || prefs?.home_experience === "classic") {
          void retireClassicHomePreference().catch((error: unknown) => {
            console.warn("[home-widgets] Could not retire the Classic Home preference", error);
          });
        }
      })
      .catch((error: unknown) => {
        console.warn("[home-widgets] Account preferences could not be loaded", error);
      });
  },

  addWidget: (id: string) => {
    const current = get().widgets;
    if (current.includes(id)) return;
    const next = [...current, id];
    writeToLocalStorage(next);
    set({ widgets: next, touched: true });
    void persistHomeWidgets(next).catch((error: unknown) => {
      console.warn(`[home-widgets] Could not sync add of ${id}`, error);
    });
  },

  removeWidget: (id: string) => {
    const next = get().widgets.filter((w) => w !== id);
    writeToLocalStorage(next);
    set({ widgets: next, touched: true });
    void persistHomeWidgets(next).catch((error: unknown) => {
      console.warn(`[home-widgets] Could not sync removal of ${id}`, error);
    });
  },

  reorderWidgets: (order: string[]) => {
    const current = get().widgets;
    // Defend against a stale/foreign order array (e.g. a race with an
    // add/remove) — only accept it if it's exactly a permutation of what's
    // currently enabled.
    if (order.length !== current.length || !order.every((id) => current.includes(id))) {
      return;
    }
    writeToLocalStorage(order);
    set({ widgets: order, touched: true });
    void persistHomeWidgets(order).catch((error: unknown) => {
      console.warn("[home-widgets] Could not sync widget order", error);
    });
  },

  isEnabled: (id: string) => get().widgets.includes(id),

  availableToAdd: () => {
    const enabled = new Set(get().widgets);
    const isMongo = getStorageMode() === "mongodb";
    return HOME_WIDGET_DEFINITIONS.filter(
      (w) => !enabled.has(w.id) && (!w.requiresMongo || isMongo),
    );
  },
}));
