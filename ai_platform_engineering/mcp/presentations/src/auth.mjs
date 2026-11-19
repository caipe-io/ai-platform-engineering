import { createRemoteJWKSet, jwtVerify } from 'jose';
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
/** Reuse the host's canonical membership API; never infer team grants from JWT hints. */
export function createAuthenticator(config, { keys, fetchImpl = fetch } = {}) {
  const jwks = keys ?? createRemoteJWKSet(new URL(config.jwks));
  return async request => {
    const bearer = /^Bearer (\S+)$/i.exec(String(request.headers.authorization || ''))?.[1];
    if (!bearer) throw new HttpError(401, 'Sign in through the host application');
    let claims;
    try {
      ({ payload: claims } = await jwtVerify(bearer, jwks, {
        issuer: config.issuer, audience: config.audience, algorithms: ['RS256', 'ES256'],
        requiredClaims: ['sub', 'exp', 'iss', 'aud'], clockTolerance: 10,
      }));
    } catch { throw new HttpError(401, 'Invalid or expired presentation token'); }
    if (typeof claims.sub !== 'string' || !claims.sub.trim() || claims.client_credentials === true ||
        String(claims.preferred_username || '').startsWith('service-account-')) throw new HttpError(403, 'A user identity is required');
    let response;
    try {
      response = await fetchImpl(`${config.hostOrigin}/api/dynamic-agents/teams`, {
        headers: { authorization: `Bearer ${bearer}` }, redirect: 'error', signal: AbortSignal.timeout(5000),
      });
    } catch { throw new HttpError(503, 'Team authorization is unavailable'); }
    if (!response.ok) throw new HttpError(response.status === 401 || response.status === 403 ? 403 : 503, 'Team authorization failed');
    const raw = await response.text();
    if (raw.length > 1024 * 1024) throw new HttpError(503, 'Invalid team authorization response');
    let result;
    try { result = JSON.parse(raw); } catch { throw new HttpError(503, 'Invalid team authorization response'); }
    if (!result.success || !Array.isArray(result.data)) throw new HttpError(503, 'Invalid team authorization response');
    const teams = new Map(result.data.filter(team => typeof team.slug === 'string' && ['member', 'admin'].includes(team.user_role))
      .map(team => [team.slug, { name: team.name || team.slug, role: team.user_role }]));
    return { subject: claims.sub, teams };
  };
}
export function canRead(identity, template) {
  return [template.owner_team, ...template.shared_with].some(team => identity.teams.has(team));
}
export function requireWriter(identity, team) {
  if (identity.teams.get(team)?.role !== 'admin') throw new HttpError(403, 'Template upload requires owner-team administration');
}
