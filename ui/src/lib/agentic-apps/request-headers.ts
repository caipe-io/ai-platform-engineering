const HOST_CONTROLLED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "remote-user",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-real-ip",
]);

const IDENTITY_HEADER_TOKENS = new Set([
  "auth",
  "authorization",
  "claims",
  "email",
  "group",
  "groups",
  "identity",
  "name",
  "position",
  "positions",
  "principal",
  "role",
  "roles",
  "subject",
  "token",
  "user",
  "username",
]);

const CONVENTIONAL_IDENTITY_HEADER_PREFIXES = [
  "x-auth-request-",
  "x-forwarded-",
  "x-remote-",
];

/**
 * Return true for headers owned by the host or the destination app's identity
 * boundary. Browser-supplied values for these headers must never reach the
 * upstream runtime.
 */
export function isHostControlledAgenticAppRequestHeader(
  headerName: string,
  appId: string,
): boolean {
  const lower = headerName.trim().toLowerCase();
  const normalizedAppId = appId.trim().toLowerCase();
  const appPrefix = `x-${normalizedAppId}-`;
  const suffix = normalizedAppId && lower.startsWith(appPrefix)
    ? lower.slice(appPrefix.length)
    : "";
  const containsIdentityToken = suffix
    .split("-")
    .some((token) => IDENTITY_HEADER_TOKENS.has(token));

  return (
    HOST_CONTROLLED_REQUEST_HEADERS.has(lower)
    || lower.startsWith("x-caipe-")
    || CONVENTIONAL_IDENTITY_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
    || containsIdentityToken
  );
}
