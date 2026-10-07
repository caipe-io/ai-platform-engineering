/** Stable authorization subject from the authenticated IdP session. */
export function deriveAgenticAppSubjectId(
  session: Record<string, unknown>,
): string | null {
  const sub = typeof session.sub === "string" ? session.sub.trim() : "";
  return sub || null;
}
