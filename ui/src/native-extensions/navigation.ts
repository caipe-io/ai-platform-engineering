export function isSafeHostHref(href: string): boolean {
  return href.startsWith("/")
    && !href.startsWith("//")
    && !href.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(href);
}
