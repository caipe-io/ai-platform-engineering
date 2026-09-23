export type ConfluenceLocatorKind = "page" | "folder" | "space";

export interface ConfluenceLocator {
  pageUrl: string;
  baseUrl: string;
  spaceKey: string;
  kind: ConfluenceLocatorKind;
  /** Page or folder ID. Absent for a whole-space locator. */
  contentId?: string;
}

const PAGE_PATH = /\/spaces\/([^/]+)\/pages\/(\d+)(?:\/|$)/;
const FOLDER_PATH = /\/spaces\/([^/]+)\/folder\/(\d+)(?:\/|$)/;
const SPACE_ROOT_PATH = /\/spaces\/([^/]+)(?:\/overview)?\/?$/;

function fromMatch(
  trimmed: string,
  parsed: URL,
  match: RegExpExecArray,
  kind: "page" | "folder",
): ConfluenceLocator {
  const basePath = parsed.pathname.slice(0, match.index).replace(/\/$/, "");
  return {
    pageUrl: trimmed,
    baseUrl: `${parsed.origin}${basePath}`,
    spaceKey: decodeURIComponent(match[1]),
    kind,
    contentId: match[2],
  };
}

/**
 * Parses a Confluence page, folder, or whole-space URL. Returns `null` when
 * the URL doesn't match any of the three recognized shapes.
 */
export function parseConfluenceLocator(value: string): ConfluenceLocator | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return null;

  const pageMatch = PAGE_PATH.exec(parsed.pathname);
  if (pageMatch && pageMatch.index !== undefined) {
    return fromMatch(trimmed, parsed, pageMatch, "page");
  }

  const folderMatch = FOLDER_PATH.exec(parsed.pathname);
  if (folderMatch && folderMatch.index !== undefined) {
    return fromMatch(trimmed, parsed, folderMatch, "folder");
  }

  const spaceMatch = SPACE_ROOT_PATH.exec(parsed.pathname);
  if (spaceMatch && spaceMatch.index !== undefined) {
    const basePath = parsed.pathname.slice(0, spaceMatch.index).replace(/\/$/, "");
    const spaceKey = decodeURIComponent(spaceMatch[1]);
    // Confluence's own UI sends users to /spaces/{key}/overview?homepageId={id}
    // when viewing a space's home page - it has no /pages/{id} segment, but
    // homepageId genuinely identifies one page, not the whole space.
    const homepageId = parsed.searchParams.get("homepageId");
    if (homepageId && /^\d+$/.test(homepageId)) {
      return {
        pageUrl: trimmed,
        baseUrl: `${parsed.origin}${basePath}`,
        spaceKey,
        kind: "page",
        contentId: homepageId,
      };
    }
    return {
      pageUrl: trimmed,
      baseUrl: `${parsed.origin}${basePath}`,
      spaceKey,
      kind: "space",
    };
  }

  return null;
}
