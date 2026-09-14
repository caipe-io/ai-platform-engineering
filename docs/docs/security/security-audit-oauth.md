# OAuth / Authentication Security Audit

**Date:** 2026-04-13
**Scope:** `ui/src/lib/auth-config.ts`, `ui/src/lib/jwt-validation.ts`, `ui/src/lib/api-middleware.ts`, auth guards, session management, API route protection, HTTP headers
**Branch:** `prebuild/fix/auth-token-refresh-loop`

---

## Risk Summary

| # | Finding | Severity | Category |
|---|---------|----------|----------|
| 1 | No HTTP security headers (CSP, HSTS, X-Frame-Options) | **HIGH** | Headers |
| 2 | accessToken exposed to client-side JS (XSS -> token theft) | **MEDIUM** | Token exposure |
| 3 | Anonymous fallback gets `role: 'admin'` when SSO disabled | **MEDIUM** | Access control |
| 4 | No server-side session revocation (JWT-based) | **MEDIUM** | Session mgmt |
| 5 | No revocation mechanism for local skills API tokens | **LOW** | Token lifecycle |
| 6 | Skills API token shares signing key with NEXTAUTH_SECRET | **LOW** | Key management |
| 7 | `/api/auth/role` returns 200 for unauthenticated requests | **LOW** | Info leak |
| 8 | Token prefix logged in debug output | **INFO** | Logging |

---

## Strengths (what's done well)

### OIDC/OAuth Flow
- **PKCE + state** checks enabled on the OIDC provider (`checks: ["pkce", "state"]`), preventing authorization code injection and CSRF on the OAuth callback.
- **Refresh token rotation** is handled with two safety nets: in-flight deduplication (concurrent callers share one HTTP exchange) and graceful `invalid_grant` (keeps the session alive when a peer already consumed the rotating token).
- **Refresh suppression** (`refreshSuppressedUntil`) prevents infinite refresh loops when the refresh token is consumed but the access token is still valid.
- **1-hour stale cutoff**: tokens expired by >1 hour are immediately marked `RefreshTokenExpired`, preventing zombie refresh attempts.
- **Group re-evaluation** every 4 hours: revoked group membership takes effect within 4h rather than persisting for the full 24h session.

### Cookie Security
- `httpOnly: true` -- session cookie cannot be read by JavaScript.
- `sameSite: 'lax'` -- mitigates CSRF for state-changing (POST/PUT/DELETE) requests.
- `secure: true` in production -- cookie only sent over HTTPS.
- **Server-side token store** (new): large OAuth tokens (`refreshToken`, `idToken`) are kept in server memory, keeping the encrypted cookie under 4096 bytes. Only `accessToken` and small metadata fields go in the cookie.

### Bearer JWT Validation (`jwt-validation.ts`)
- JWKS discovery from OIDC provider with caching.
- Validates `issuer` and `audience` claims.
- Bearer users get `role: 'user'` only -- no admin escalation via API tokens (principle of least privilege).
- Local skills API tokens are explicitly typed (`type: 'skills_api_key'`) to prevent confusion with OIDC JWTs, scoped to `skills:read`, and capped at 90 days.

### API Route Protection (`api-middleware.ts`)
- `withAuth()` wrapper enforces session authentication consistently.
- `getAuthFromBearerOrSession()` supports dual auth (Bearer JWT + cookie session) with local-token-first fast path.
- RBAC via `requireAdmin()`, `requireAdminView()`, `requireOwnership()`.
- Conversation-level access control with multi-level sharing (owner, shared, shared_readonly, admin_audit).

### Client-Side Resilience
- **Redirect loop circuit breaker** in login page (3 redirects in 10s -> session reset).
- **Token expiry guard** with silent refresh, warning toast, and graceful logout.
- **BroadcastChannel** coordination for cross-tab session refresh.
- **15-second auto-reset** in AuthGuard when authorization check is stuck.

---

## Findings

### 1. [HIGH] No HTTP Security Headers

**Location:** `ui/next.config.ts`, no `middleware.ts`

The application sets **zero** HTTP security headers:

| Header | Status | Risk |
|--------|--------|------|
| `Content-Security-Policy` | Missing | XSS amplification -- injected scripts can load external resources freely |
| `Strict-Transport-Security` | Missing | HTTPS downgrade attacks on first visit |
| `X-Frame-Options` / `frame-ancestors` | Missing | Clickjacking -- app can be embedded in hostile iframes |
| `X-Content-Type-Options` | Missing | MIME sniffing attacks |
| `Referrer-Policy` | Missing | OAuth tokens/session IDs can leak in Referer headers to linked sites |
| `Permissions-Policy` | Missing | Browser features (camera, microphone, geolocation) not restricted |

**Recommendation:** Add a Next.js middleware or use `headers` in `next.config.ts`:

```typescript
// next.config.ts
headers: async () => [{
  source: '/(.*)',
  headers: [
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss: https:; frame-ancestors 'none';" },
  ],
}],
```

---

### 2. [MEDIUM] accessToken Exposed to Client-Side JavaScript

**Location:** `auth-config.ts:610`, `user-menu.tsx:413`, `SkillsRunner.tsx:737`, `AgentBuilderRunner.tsx:737`, `DynamicAgentContext.tsx:131`

The OIDC `access_token` is passed into the browser session (`session.accessToken`) and used directly in client-side `fetch()` calls:

```typescript
// session callback exposes token to client
session.accessToken = token.accessToken as string;

// Client components use it directly
headers["Authorization"] = `Bearer ${session.accessToken}`;
```

**Impact:** If an XSS vulnerability exists anywhere in the app, the attacker can exfiltrate the access token and impersonate the user against all backend APIs until the token expires.

**Mitigations already in place:**
- `httpOnly` session cookie prevents direct cookie theft
- `sameSite: 'lax'` limits CSRF surface

**Recommendation:** Keep streaming calls proxied through Next.js server-side routes (like the RAG proxy already does). This eliminates client-side token exposure entirely. The `accessToken` would never leave the server.

For routes that already proxy (RAG, skills, MCP servers, dynamic agents), the server-side `getServerSession()` pattern is correct and does not expose the token.

---

### 3. [MEDIUM] Anonymous Fallback Gets Admin Role When SSO Disabled

**Location:** `api-middleware.ts:52-54`

```typescript
if (allowAnonymous && !getConfig('ssoEnabled')) {
  const fallbackUser = { email: 'anonymous@local', name: 'Anonymous', role: 'admin' };
  return { user: fallbackUser, session: { role: 'admin', canViewAdmin: true } };
}
```

When `SSO_ENABLED` is not `"true"`, all API routes using `withAuth()` fall back to an anonymous admin user. This is intentional for local development but dangerous if:
- SSO is accidentally disabled in production via misconfiguration
- The env var is unset or misspelled

**Recommendation:**
- Add a startup check that logs a prominent warning when SSO is disabled
- Consider requiring an explicit `ALLOW_ANONYMOUS_ADMIN=true` env var in addition to SSO being disabled
- Set `role: 'user'` for the anonymous fallback (require explicit admin opt-in even in dev)

---

### 4. [MEDIUM] No Server-Side Session Revocation

**Location:** Architectural (JWT strategy)

JWT sessions cannot be revoked server-side. If a user's account is compromised or they leave the organization, the session remains valid until:
- The 24-hour `maxAge` expires, OR
- The refresh token is revoked at the OIDC provider (takes up to 4h to propagate via group re-check)

**Mitigations already in place:**
- 4-minute `refetchInterval` triggers JWT callback which can detect errors
- Group re-evaluation every 4 hours catches membership revocation

**Recommendation:**
- For immediate revocation needs, maintain a server-side blocklist (Redis set of revoked `sub` values) checked in the JWT callback
- Alternatively, consider switching to database sessions for environments requiring instant revocation

---

### 5. [LOW] No Revocation for Local Skills API Tokens

**Location:** `jwt-validation.ts:159-178`, `/api/skills/token/route.ts`

Generated skills API tokens (HS256 JWT, up to 90 days) have no revocation mechanism. Once issued, they're valid until expiry.

**Recommendation:** Maintain a revocation list (e.g., a MongoDB collection of revoked token JTIs) checked in `validateLocalSkillsJWT()`.

---

### 6. [LOW] Skills Token Shares Signing Key with NEXTAUTH_SECRET

**Location:** `jwt-validation.ts:129`

```typescript
function getLocalSigningKey(): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET;
```

The skills API token uses `NEXTAUTH_SECRET` as its HS256 signing key. If this secret leaks, both session encryption AND skills token forgery are compromised.

**Mitigation already in place:** The `type: 'skills_api_key'` claim prevents a forged skills token from being confused with a session token (they use different validation paths).

**Recommendation:** Use a separate `SKILLS_API_SECRET` env var for key isolation.

---

### 7. [LOW] `/api/auth/role` Returns 200 for Unauthenticated Requests

**Location:** `auth/role/route.ts:11-13`

```typescript
if (!session || !session.user?.email) {
  return NextResponse.json({ role: 'user' }, { status: 200 });
}
```

Unauthenticated requests get a 200 with `{ role: 'user' }` instead of 401. This leaks the endpoint's existence and could confuse clients into thinking they're authenticated as a `user` role.

**Recommendation:** Return 401 for unauthenticated requests.

---

### 8. [INFO] Token Prefix Logged in Debug Output

**Location:** `user/info/route.ts:39`

```typescript
accessTokenPrefix: session?.accessToken ? session.accessToken.substring(0, 20) + '...' : 'MISSING',
```

The first 20 characters of the access token are logged. While truncated, this could aid targeted attacks if log files are compromised.

**Recommendation:** Log only a boolean (`hasAccessToken: true/false`) or reduce to 8 characters.

---

## Architecture Diagram

```
Browser                         Next.js Server                    Backend Services
┌───────────┐                  ┌─────────────────┐               ┌──────────────┐
│           │   httpOnly cookie │                 │  Bearer JWT   │              │
│  Session  │ ────────────────>│  JWT Decode      │──────────────>│  RAG Server  │
│  Cookie   │  (accessToken +  │  (rehydrate from │               │  (validates  │
│  (slim)   │   metadata only) │   token store)   │               │   JWT sig)   │
│           │                  │                 │               │              │
│           │   /api/auth/     │  JWT Callback   │  Bearer JWT   │              │
│  useSession()  session       │  (refresh if    │──────────────>│  Agent API   │
│           │<────────────────│   near expiry)   │               │              │
│           │                  │                 │               │              │
│ Chat UI   │  Direct Bearer   │  JWT Encode     │               │              │
│ (client)  │──────────────────┤  (strip tokens, │               │              │
│           │  (⚠ token in JS) │   encrypt slim) │               │              │
└───────────┘                  └─────────────────┘               └──────────────┘
                                       │
                                       │ In-memory
                                       ▼
                               ┌─────────────────┐
                               │  Token Store     │
                               │  (refreshToken,  │
                               │   idToken)       │
                               │  keyed by sub    │
                               │  TTL: 24h        │
                               └─────────────────┘
```

---

## Checklist Status

| Control | Status |
|---------|--------|
| PKCE on OAuth flow | PASS |
| State parameter on OAuth flow | PASS |
| httpOnly session cookie | PASS |
| Secure cookie (production) | PASS |
| SameSite cookie attribute | PASS (lax) |
| CSRF token for auth endpoints | PASS (NextAuth built-in) |
| Token refresh before expiry | PASS |
| Refresh token rotation handling | PASS |
| Concurrent refresh deduplication | PASS |
| Session maxAge limit | PASS (24h) |
| Group-based authorization | PASS |
| Admin role RBAC | PASS |
| Bearer JWT JWKS validation | PASS |
| CSP header | **FAIL** |
| HSTS header | **FAIL** |
| X-Frame-Options header | **FAIL** |
| X-Content-Type-Options header | **FAIL** |
| Server-side session revocation | **FAIL** |
| Token not exposed to client JS | **PARTIAL** (server routes good, direct streaming path bad) |
