export interface ConfluencePageUrl {
  pageUrl: string;
  baseUrl: string;
  spaceKey: string;
  pageId: string;
}

export function parseConfluencePageUrl(value: string): ConfluencePageUrl | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;

    const match = /\/spaces\/([^/]+)\/pages\/(\d+)(?:\/|$)/.exec(
      parsed.pathname,
    );
    if (!match || match.index === undefined) return null;

    const basePath = parsed.pathname.slice(0, match.index).replace(/\/$/, "");
    return {
      pageUrl: trimmed,
      baseUrl: `${parsed.origin}${basePath}`,
      spaceKey: decodeURIComponent(match[1]),
      pageId: match[2],
    };
  } catch {
    return null;
  }
}
