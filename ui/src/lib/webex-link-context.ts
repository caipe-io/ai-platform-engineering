/** Return destinations are local UI paths, never URLs supplied by a provider. */
export function safeWebexReturnTo(value: string | null | undefined): string | undefined {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//") || /[\\%\x00-\x20\x7f]/.test(value)) return undefined;
  try {
    const url = new URL(value, "https://example.test");
    if (url.origin !== "https://example.test" || url.pathname.startsWith("/api/") || url.pathname === "/login") return undefined;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return undefined; }
}

export function safeWebexBotId(value: string | null | undefined): string | undefined {
  return value && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value) ? value : undefined;
}
