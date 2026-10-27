import { ownsAppPath } from "./host-routes";

export interface FrameBreadcrumb { label: string; href?: string }

/** Breadcrumbs are presentation data; links stay within this app or the host home. */
export function parseFrameBreadcrumbs(value: unknown, roots: string[]): FrameBreadcrumb[] | null {
  if (!Array.isArray(value) || value.length > 12) return null;
  const result: FrameBreadcrumb[] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["label", "href"].includes(key))) return null;
    if (typeof item.label !== "string" || !item.label.trim() || item.label.length > 120 || /[\u0000-\u001f\u007f]/.test(item.label)) return null;
    if (item.href !== undefined) {
      if (typeof item.href !== "string" || item.href.length > 2048 || !item.href.startsWith("/") || item.href.startsWith("//") || /[\\\u0000-\u0020]/.test(item.href)) return null;
      const url = new URL(item.href, "https://example.test");
      if (!(index === 0 && item.href === "/") && !roots.some(root => ownsAppPath(root, url.pathname))) return null;
    }
    result.push({ label: item.label.trim(), ...(item.href !== undefined ? { href: item.href } : {}) });
  }
  return result;
}
