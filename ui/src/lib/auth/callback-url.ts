export const AUTH_RETURN_TO_HEADER = "x-caipe-auth-return-to";
export const LOGIN_RETURN_TO_KEY = "login-return-to";
const RETURN_TO_TTL_MS = 15 * 60_000;

/** Accept local paths or absolute callbacks from the browser's own origin. */
export function normalizeCallbackUrl(value: string | null, origin?: string): string {
  if (!value || /[\u0000-\u0020\u007f]/.test(value) || value.startsWith("//")) return "/";
  // URL parsing treats path/authority backslashes as slashes, but query and
  // fragment backslashes are ordinary destination data.
  if (value.split(/[?#]/, 1)[0].includes("\\")) return "/";
  if (!value.startsWith("/") && (!origin || !/^https?:\/\//i.test(value))) return "/";
  try {
    const base = new URL(origin ?? "https://return.example");
    const url = new URL(value, base);
    if (url.origin !== base.origin || url.username || url.password ||
        !["https:", "http:"].includes(url.protocol) ||
        url.pathname.startsWith("//") || url.pathname.startsWith("/login")) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

export function buildLoginUrl(target: string | null, params?: string): string {
  const callback = normalizeCallbackUrl(target);
  const query = [params, callback !== "/" ? `callbackUrl=${encodeURIComponent(callback)}` : ""]
    .filter(Boolean).join("&");
  return query ? `/login?${query}` : "/login";
}

function warnStorageUnavailable(): void {
  console.warn("[Login] Tab-local login recovery storage unavailable");
}

export function clearLoginReturnTo(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(LOGIN_RETURN_TO_KEY);
  } catch {
    warnStorageUnavailable();
  }
}

/** Keep retries in this tab without retaining a destination across later logins. */
export function rememberLoginReturnTo(value: string): void {
  if (typeof window === "undefined") return;
  const path = normalizeCallbackUrl(value, window.location.origin);
  if (path === "/") {
    clearLoginReturnTo();
    return;
  }
  try {
    window.sessionStorage.setItem(LOGIN_RETURN_TO_KEY, JSON.stringify({ path, savedAt: Date.now() }));
  } catch {
    warnStorageUnavailable();
  }
}

export function getLoginCallbackUrl(value: string | null, recovering = false): string {
  const origin = typeof window === "undefined" ? undefined : window.location.origin;
  if (value !== null) return normalizeCallbackUrl(value, origin);
  if (!recovering || typeof window === "undefined") return "/";
  let record: string | null;
  try {
    record = window.sessionStorage.getItem(LOGIN_RETURN_TO_KEY);
  } catch {
    warnStorageUnavailable();
    return "/";
  }
  if (!record) return "/";
  let parsed: unknown;
  try {
    parsed = JSON.parse(record);
  } catch {
    clearLoginReturnTo();
    return "/";
  }
  if (parsed && typeof parsed === "object" && "path" in parsed && "savedAt" in parsed) {
    const { path, savedAt } = parsed;
    const callback = typeof path === "string" ? normalizeCallbackUrl(path, origin) : "/";
    if (callback !== "/" && callback === path && typeof savedAt === "number" && Number.isFinite(savedAt)) {
      const age = Date.now() - savedAt;
      if (age >= 0 && age < RETURN_TO_TTL_MS) return callback;
    }
  }
  clearLoginReturnTo();
  return "/";
}
