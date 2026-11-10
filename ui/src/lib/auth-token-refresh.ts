import { RefreshRejectedError, RefreshRetryableError, SessionExpiredError, SessionUnavailableError, type StoredTokens } from './auth-token-store';

function validatedEndpoint(raw: string): URL {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Invalid OIDC endpoint');
  }
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonemptyToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validLifetime(value: unknown, now: number, allowZero = false): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= (allowZero ? 0 : 1) && Number.isSafeInteger(now + value);
}

/** Expiry comes from the same trusted OAuth response as the token, never a cookie. */
export function accessTokenExpiry(accessToken: string, responseExpiry?: number): number {
  let jwtExpiry: number | undefined;
  try {
    // Metadata only, not signature verification. Downstream validation remains required.
    const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
    if (typeof claims.exp === 'number' && Number.isFinite(claims.exp)) jwtExpiry = claims.exp;
  } catch { /* Opaque access tokens use the provider's expiry metadata. */ }
  const candidates = [jwtExpiry, responseExpiry].filter((value): value is number =>
    typeof value === 'number' && Number.isFinite(value));
  if (!candidates.length) throw new SessionUnavailableError();
  return Math.min(...candidates);
}

export async function exchangeRefreshToken(tokens: StoredTokens): Promise<StoredTokens> {
  const now = Math.floor(Date.now() / 1000);
  if (!tokens.refreshToken || (tokens.refreshTokenExpiresAt && tokens.refreshTokenExpiresAt <= now)) {
    throw new RefreshRejectedError();
  }
  const internalIssuer = process.env.OIDC_DISCOVERY_URL?.trim();
  const issuer = internalIssuer || process.env.OIDC_ISSUER?.trim();
  const configuredEndpoint = process.env.OIDC_TOKEN_ENDPOINT?.trim();
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  if (!issuer || !clientId || !clientSecret) throw new RefreshRetryableError();
  let endpoint: string;
  try {
    const issuerUrl = validatedEndpoint(issuer);
    const realmBase = issuerUrl.toString().replace(/\/\.well-known\/openid-configuration\/?$/, '').replace(/\/$/, '');
    const isKeycloakRealm = /\/realms\/[^/]+$/.test(issuerUrl.pathname.replace(/\/\.well-known\/openid-configuration\/?$/, '').replace(/\/$/, ''));
    if (configuredEndpoint) {
      endpoint = configuredEndpoint;
    } else if (internalIssuer && isKeycloakRealm) {
      endpoint = `${realmBase}/protocol/openid-connect/token`;
    } else {
      // Plaintext discovery cannot choose where client credentials are sent.
      // Internal HTTP providers must pin their token endpoint in configuration.
      if (issuerUrl.protocol !== 'https:') throw new Error('OIDC discovery requires HTTPS');
      try {
        const discovery = await fetch(`${realmBase}/.well-known/openid-configuration`, {
          next: { revalidate: 3600 }, redirect: 'error', signal: AbortSignal.timeout(5000),
        });
        if (!discovery.ok) throw new Error('OIDC discovery failed');
        const configuration: unknown = await discovery.json();
        if (!isRecord(configuration) || !nonemptyToken(configuration.token_endpoint)) {
          throw new Error('OIDC discovery omitted token_endpoint');
        }
        endpoint = configuration.token_endpoint;
      } catch (error) {
        if (!isKeycloakRealm) throw error;
        endpoint = `${realmBase}/protocol/openid-connect/token`;
      }
    }
    const parsed = validatedEndpoint(endpoint);
    // An explicit internal HTTP override is allowed; discovery cannot downgrade TLS.
    if (!configuredEndpoint && issuerUrl.protocol === 'https:' && parsed.protocol !== 'https:') {
      throw new Error('Insecure OIDC discovery token endpoint');
    }
  } catch {
    // No exchange was sent, so retrying after the shared cooldown is safe.
    throw new RefreshRetryableError();
  }
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), cache: 'no-store',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
      grant_type: 'refresh_token', refresh_token: tokens.refreshToken }),
  });
  // A proxy 5xx may hide a successful rotation. Do not replay that refresh token.
  if (response.status >= 500) throw new SessionUnavailableError();
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new SessionUnavailableError(); }
  if (!isRecord(data)) throw new SessionUnavailableError();
  if (!response.ok) {
    if (data.error === 'invalid_grant' || data.error === 'invalid_token') throw new RefreshRejectedError();
    if (data.error === 'temporarily_unavailable' || data.error === 'invalid_client') throw new RefreshRetryableError();
    throw new SessionUnavailableError();
  }
  // Validate the entire result before publishing any rotated credentials. A malformed
  // success may have consumed the old refresh token, so it is never safe to replay.
  if (data.error !== undefined || !nonemptyToken(data.access_token)
    || (data.refresh_token !== undefined && !nonemptyToken(data.refresh_token))
    || (data.id_token !== undefined && data.id_token !== null && !nonemptyToken(data.id_token))
    || (data.expires_in !== undefined && !validLifetime(data.expires_in, now))
    || (data.refresh_expires_in !== undefined && !validLifetime(data.refresh_expires_in, now, true))) {
    throw new SessionUnavailableError();
  }
  const expiresAt = accessTokenExpiry(data.access_token,
    typeof data.expires_in === 'number' ? now + data.expires_in : undefined);
  if (expiresAt <= Math.floor(Date.now() / 1000)) throw new SessionExpiredError();
  return {
    accessToken: data.access_token, expiresAt,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : tokens.refreshToken,
    idToken: typeof data.id_token === 'string' ? data.id_token : undefined,
    refreshTokenExpiresAt: typeof data.refresh_expires_in === 'number' && data.refresh_expires_in > 0
      ? now + data.refresh_expires_in : tokens.refreshTokenExpiresAt,
  };
}
