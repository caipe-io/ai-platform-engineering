/**
 * Resolve the public-facing origin (`https://host`) for URLs we hand back
 * to clients (install.sh `base_url`, live-skills callback URL, same-origin
 * checks for `catalog_url`).
 *
 * Why we can't just use `new URL(request.url).origin`:
 *   Inside a Next.js route handler running behind an ingress, `request.url`
 *   is the *internal* listen address (e.g. `http://0.0.0.0:3000` or
 *   `http://caipe-ui.caipe-prod.svc:3000`), not the public hostname the
 *   user actually called. Baking that into a script makes the script try
 *   to call back into the pod IP and fail with TLS / connection errors.
 *
 * Resolution order (highest priority first):
 *   1. `NEXTAUTH_URL` env var. This is the canonical public origin in this
 *      codebase — already required by NextAuth for OIDC redirects, set by
 *      `setup-caipe.sh` to `https://${CAIPE_DOMAIN}`, and documented as a
 *      Helm value (`caipe-ui.config.NEXTAUTH_URL`). If OIDC login works in
 *      a deployment, NEXTAUTH_URL is correct.
 *   2. `x-forwarded-host` + `x-forwarded-proto` request headers (only the
 *      first comma-separated value is honored). Useful in dev/preview
 *      environments where NEXTAUTH_URL might still be `http://localhost:3000`
 *      but the user is browsing through a real ingress.
 *   3. `new URL(request.url).origin` — the unproxied / pure-localhost dev
 *      fallback. This is the only path that can return a pod-internal URL,
 *      and only fires when both (1) and (2) are missing.
 */

import { originFromNextAuthUrl } from "@/lib/request-origin";

const HOST_RE = /^[A-Za-z0-9.\-_]+(?::\d{1,5})?$/;

function sanitizeProto(raw: string | null | undefined): "http" | "https" | null {
  if (!raw) return null;
  const v = raw.split(",")[0].trim().toLowerCase();
  return v === "http" || v === "https" ? v : null;
}

function sanitizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.split(",")[0].trim();
  return v && HOST_RE.test(v) ? v : null;
}

export function getRequestOrigin(request: Request): string {
  const fromEnv = originFromNextAuthUrl();
  if (fromEnv) return fromEnv;

  const headers = request.headers;
  const xfProto = sanitizeProto(headers.get("x-forwarded-proto"));
  const xfHost = sanitizeHost(headers.get("x-forwarded-host"));
  if (xfProto && xfHost) return `${xfProto}://${xfHost}`;

  try {
    return new URL(request.url).origin;
  } catch {
    return "http://localhost:3000";
  }
}
