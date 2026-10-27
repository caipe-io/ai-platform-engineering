/**
 * `NEXTAUTH_URL` is the canonical public origin in this codebase — already
 * required by NextAuth for OIDC redirects, set by `setup-caipe.sh` to
 * `https://${CAIPE_DOMAIN}`, and documented as a Helm value
 * (`caipe-ui.config.NEXTAUTH_URL`). Validated (trimmed, http/https only) so a
 * malformed value falls through to a caller's own fallback instead of
 * producing a broken URL.
 */
export function originFromNextAuthUrl(): string | null {
  const raw = process.env.NEXTAUTH_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}
