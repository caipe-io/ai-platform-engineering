export interface AgentCompletionPreferences {
  browserEnabled: boolean;
  chimeEnabled: boolean;
}

export interface AgentCompletionAlert {
  agentName?: string;
  conversationId: string;
  href?: string;
  messageId: string;
}

export type BrowserNotificationCapability = NotificationPermission | "unsupported";

const STORAGE_KEYS = {
  browserEnabled: "caipe-agent-completion-browser-enabled",
  chimeEnabled: "caipe-agent-completion-chime-enabled",
} as const;

const DEFAULT_PREFERENCES: AgentCompletionPreferences = {
  browserEnabled: false,
  chimeEnabled: false,
};

let settingsLoadPromise: Promise<AgentCompletionPreferences> | null = null;
let audioContext: AudioContext | null = null;
let notificationServiceWorkerPromise: Promise<ServiceWorkerRegistration | null> | null = null;

function readBoolean(key: string): boolean | undefined {
  if (typeof window === "undefined") return undefined;
  const value = window.localStorage.getItem(key);
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function readCachedAgentCompletionPreferences(): AgentCompletionPreferences {
  return {
    browserEnabled: readBoolean(STORAGE_KEYS.browserEnabled) ?? DEFAULT_PREFERENCES.browserEnabled,
    chimeEnabled: readBoolean(STORAGE_KEYS.chimeEnabled) ?? DEFAULT_PREFERENCES.chimeEnabled,
  };
}

export function cacheAgentCompletionPreferences(preferences: AgentCompletionPreferences): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEYS.browserEnabled,String(preferences.browserEnabled));
  window.localStorage.setItem(STORAGE_KEYS.chimeEnabled,String(preferences.chimeEnabled));
  settingsLoadPromise = Promise.resolve(preferences);
}

export async function loadAgentCompletionPreferences(): Promise<AgentCompletionPreferences> {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  if (settingsLoadPromise) return settingsLoadPromise;

  settingsLoadPromise = fetch("/api/settings",{ cache: "no-store" })
    .then(async (response) => {
      const body = await response.json();
      if (!response.ok || !body.success) {
        throw new Error(body.error || "Could not load notification preferences");
      }
      const notifications = body.data?.notifications;
      const preferences = {
        browserEnabled: notifications?.agent_completion_browser_enabled === true,
        chimeEnabled: notifications?.agent_completion_chime_enabled === true,
      };
      cacheAgentCompletionPreferences(preferences);
      return preferences;
    })
    .catch(() => readCachedAgentCompletionPreferences());

  return settingsLoadPromise;
}

export function resetAgentCompletionPreferenceLoad(): void {
  settingsLoadPromise = null;
  notificationServiceWorkerPromise = null;
}

export function getBrowserNotificationCapability(): BrowserNotificationCapability {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationCapability> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.requestPermission();
}

async function getNotificationServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (
    typeof navigator === "undefined"
    || !("serviceWorker" in navigator)
    || !navigator.serviceWorker
  ) return null;
  if (!notificationServiceWorkerPromise) {
    notificationServiceWorkerPromise = navigator.serviceWorker
      .register("/caipe-notification-sw.js",{ scope: "/" })
      .then(async (registration) => {
        // register() may resolve while a newly installed worker is still
        // activating. showNotification() requires an active worker and can
        // otherwise fail before falling back to the less reliable page API.
        if (registration.active) return registration;
        return navigator.serviceWorker.ready;
      })
      .catch(() => null);
  }
  return notificationServiceWorkerPromise;
}

/** Prepare persistent notification delivery while the page is active. */
export async function prepareBrowserNotificationDelivery(): Promise<boolean> {
  if (getBrowserNotificationCapability() !== "granted") return false;
  if (await getNotificationServiceWorker()) return true;
  return typeof window !== "undefined" && "Notification" in window;
}

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (audioContext && audioContext.state !== "closed") return audioContext;

  const AudioContextConstructor = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return null;
  audioContext = new AudioContextConstructor();
  return audioContext;
}

function notificationTargetPath(alert: AgentCompletionAlert): string {
  const href = alert.href?.trim();
  if (href?.startsWith("/") && !href.startsWith("//")) return href;
  return `/chat/${encodeURIComponent(alert.conversationId)}`;
}

/**
 * Call from a click/key handler so browser autoplay policy allows a later
 * background completion chime.
 */
export async function primeCompletionChime(): Promise<boolean> {
  const context = getAudioContext();
  if (!context) return false;
  if (context.state !== "running") {
    try {
      await context.resume();
    } catch {
      return false;
    }
  }
  return context.state === "running";
}

export async function playCompletionChime(): Promise<boolean> {
  const context = getAudioContext();
  if (!context || !(await primeCompletionChime())) return false;

  const playTone = (frequency: number,startsAt: number,duration: number): void => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency,startsAt);
    gain.gain.setValueAtTime(0.0001,startsAt);
    gain.gain.exponentialRampToValueAtTime(0.075,startsAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001,startsAt + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(startsAt);
    oscillator.stop(startsAt + duration);
  };

  const now = context.currentTime;
  playTone(659.25,now,0.18);
  playTone(880,now + 0.11,0.24);
  return true;
}

export function shouldAlertForCurrentPage(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  return document.hidden || !document.hasFocus();
}

async function showBrowserNotification(alert: AgentCompletionAlert): Promise<boolean> {
  if (getBrowserNotificationCapability() !== "granted") return false;

  const agentLabel = alert.agentName?.trim() || "Agent";
  const title = `${agentLabel} finished`;
  // `renotify` is supported by Chromium's Notification API but is not yet
  // included in every TypeScript DOM library version.
  const options: NotificationOptions & { renotify?: boolean } = {
    body: "Your response is ready.",
    data: {
      conversationId: alert.conversationId,
      href: notificationTargetPath(alert),
      messageId: alert.messageId,
    },
    icon: "/icon.ico",
    // Each completed message must have its own identity. Reusing only the
    // conversation ID lets Chrome silently replace the prior notification.
    tag: `caipe-agent-completion-${alert.conversationId}-${alert.messageId}`,
    renotify: true,
    requireInteraction: true,
    silent: false,
  };

  const registration = await getNotificationServiceWorker();
  if (registration) {
    try {
      await registration.showNotification(title,options);
      return true;
    } catch {
      // Fall back to the page Notification API below.
    }
  }

  try {
    const notification = new window.Notification(title,options);
    notification.onclick = () => {
      window.focus();
      window.location.assign(notificationTargetPath(alert));
      notification.close();
    };
    return true;
  } catch {
    // Desktop Notification construction is not supported by every browser,
    // notably several mobile implementations. The in-app response still works.
    return false;
  }
}

export async function deliverAgentCompletionAlert(
  alert: AgentCompletionAlert,
  options: { force?: boolean; preferences?: AgentCompletionPreferences } = {},
): Promise<{ chimePlayed: boolean; notificationShown: boolean }> {
  if (!options.force && !shouldAlertForCurrentPage()) {
    return { chimePlayed: false,notificationShown: false };
  }

  const preferences = options.preferences ?? await loadAgentCompletionPreferences();
  const [chimePlayed,notificationShown] = await Promise.all([
    preferences.chimeEnabled ? playCompletionChime() : Promise.resolve(false),
    preferences.browserEnabled ? showBrowserNotification(alert) : Promise.resolve(false),
  ]);
  return { chimePlayed,notificationShown };
}
