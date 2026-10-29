import { encode, type JWT } from 'next-auth/jwt';
import { createSession, SESSION_FORMAT } from '../../src/lib/auth-token-store';

/** Seed the real server-side session contract, not a production decoder bypass. */
export async function encodeTestSession(params: { secret: string; maxAge: number; token: JWT }): Promise<string> {
  const { token } = params;
  if (!token.sub || !token.accessToken || typeof token.expiresAt !== 'number') {
    throw new Error('Test session needs subject, access token and expiry');
  }
  const stored = await createSession(token.sub, {
    accessToken: token.accessToken, expiresAt: token.expiresAt,
    refreshToken: token.refreshToken,
  });
  const cookie = { ...token, sessionId: stored.sessionId, sessionFormat: SESSION_FORMAT };
  delete cookie.accessToken;
  delete cookie.refreshToken;
  delete cookie.expiresAt;
  return encode({ ...params, token: cookie });
}
