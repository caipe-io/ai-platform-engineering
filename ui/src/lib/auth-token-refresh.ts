import { RefreshRejectedError, RefreshRetryableError, SessionExpiredError, SessionUnavailableError, type StoredTokens } from './auth-token-store';

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
    const realmBase = issuer.replace(/\/\.well-known\/openid-configuration\/?$/, '').replace(/\/$/, '');
    const isKeycloakRealm = /\/realms\/[^/]+$/.test(new URL(realmBase).pathname);
    if (configuredEndpoint) {
      endpoint = configuredEndpoint;
    } else if (internalIssuer && isKeycloakRealm) {
      endpoint = `${realmBase}/protocol/openid-connect/token`;
    } else {
      try {
        const discovery = await fetch(`${realmBase}/.well-known/openid-configuration`, {
          next: { revalidate: 3600 }, signal: AbortSignal.timeout(5000),
        });
        if (!discovery.ok) throw new Error('OIDC discovery failed');
        const configuration = await discovery.json();
        if (typeof configuration?.token_endpoint !== 'string' || !configuration.token_endpoint.trim()) {
          throw new Error('OIDC discovery omitted token_endpoint');
        }
        endpoint = configuration.token_endpoint;
      } catch (error) {
        if (!isKeycloakRealm) throw error;
        endpoint = `${realmBase}/protocol/openid-connect/token`;
      }
    }
    const parsed = new URL(endpoint);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('Invalid OIDC token endpoint');
    }
  } catch {
    // No exchange was sent, so retrying after the shared cooldown is safe.
    throw new RefreshRetryableError();
  }
  const response = await fetch(endpoint, {
    method: 'POST', signal: AbortSignal.timeout(10_000), cache: 'no-store',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
      grant_type: 'refresh_token', refresh_token: tokens.refreshToken }),
  });
  // A proxy 5xx may hide a successful rotation. Do not replay that refresh token.
  if (response.status >= 500) throw new SessionUnavailableError();
  const data = await response.json();
  if (!response.ok) {
    if (data.error === 'invalid_grant' || data.error === 'invalid_token') throw new RefreshRejectedError();
    if (data.error === 'temporarily_unavailable' || data.error === 'invalid_client') throw new RefreshRetryableError();
    throw new SessionUnavailableError();
  }
  if (typeof data.access_token !== 'string' || !data.access_token) throw new SessionUnavailableError();
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
