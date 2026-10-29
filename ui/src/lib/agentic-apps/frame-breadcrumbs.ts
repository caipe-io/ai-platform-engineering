import type { NativeExtensionBreadcrumb } from "../../../app-sdk";

import { ownsAppPath } from "./host-routes";

export type FrameBreadcrumb = NativeExtensionBreadcrumb;

/** Breadcrumbs are presentation data; links stay within this app or the host home. */
export function parseFrameBreadcrumbs(value: unknown, roots: string[]): FrameBreadcrumb[] | null {
  if (!Array.isArray(value) || value.length > 12) return null;
  const result: FrameBreadcrumb[] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["label", "href", "tone", "icon"].includes(key))) return null;
    if (typeof item.label !== "string" || !item.label.trim() || item.label.length > 120 || /[\u0000-\u001f\u007f]/.test(item.label)) return null;
    if (item.tone !== undefined && !["primary", "info"].includes(item.tone)) return null;
    if (item.icon !== undefined && !["target", "layers"].includes(item.icon)) return null;
    if (item.href !== undefined) {
      if (typeof item.href !== "string" || item.href.length > 2048 || !item.href.startsWith("/") || item.href.startsWith("//") || /[\\\u0000-\u0020]/.test(item.href)) return null;
      const url = new URL(item.href, "https://example.test");
      if (!(index === 0 && item.href === "/") && !roots.some(root => ownsAppPath(root, url.pathname))) return null;
    }
    result.push({ label: item.label.trim(), ...(item.href !== undefined ? { href: item.href } : {}),
      ...(item.tone !== undefined ? { tone: item.tone } : {}),
      ...(item.icon !== undefined ? { icon: item.icon } : {}),
    });
  }
  return result;
}
