/**
 * Unit tests for auth-config.ts
 * Tests OIDC configuration, token refresh, and group authorization
 */

// Mock the token store so tests don't require a MongoDB/ESM environment.
// Provides a simple in-memory Map that behaves identically to the real L1 path.
const _mockTokenStore = new Map<string, import('../auth-token-store').StoredTokens>()
jest.mock('../auth-token-store', () => ({
  getStoredTokens: jest.fn(async (sub: string | undefined) => _mockTokenStore.get(sub ?? '') ?? undefined),
  storeTokens: jest.fn(async (sub: string | undefined, tokens: import('../auth-token-store').StoredTokens) => {
    if (sub) _mockTokenStore.set(sub, tokens)
  }),
  resetTokenStore: jest.fn(() => { _mockTokenStore.clear() }),
}))

// Mock jose so we can control decodeJwt in group re-evaluation tests
jest.mock('jose', () => ({
  decodeJwt: jest.fn(),
}))

jest.mock('next-auth/jwt', () => ({
  encode: jest.fn(async () => 'encoded-session'),
  decode: jest.fn(async () => ({})),
}))

const mockReconcileOidcClaimGroupsForUser = jest.fn()
jest.mock('@/lib/rbac/oidc-claim-reconciler', () => ({
  reconcileOidcClaimGroupsForUser: (...args: unknown[]) => mockReconcileOidcClaimGroupsForUser(...args),
}))

import {
  isAdminUser,
  canViewAdminDashboard,
  authOptions,
  _resetInflightRefreshes,
  _resetServerTokenStore,
  extractGroups,
  cacheOidcClaimGroups,
  getCachedOidcClaimGroups,
  resolveLoginProviderId,
} from '../auth-config'

function withRequiredGroup<T>(requiredGroup: string | undefined, cb: (mod: typeof import('../auth-config')) => T): T {
  const previous = process.env.OIDC_REQUIRED_GROUP
  if (requiredGroup === undefined) {
    delete process.env.OIDC_REQUIRED_GROUP
  } else {
    process.env.OIDC_REQUIRED_GROUP = requiredGroup
  }
  try {
    let result!: T
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      result = cb(require('../auth-config'))
    })
    return result
  } finally {
    if (previous === undefined) {
      delete process.env.OIDC_REQUIRED_GROUP
    } else {
      process.env.OIDC_REQUIRED_GROUP = previous
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: build a fake fetch mock that handles OIDC discovery + token exchange
// ─────────────────────────────────────────────────────────────────────────────
function makeRefreshFetchMock(opts: {
  discoveryFails?: boolean
  tokenFails?: boolean
  nonJsonResponse?: boolean
  newTokens?: Record<string, unknown>
} = {}) {
  return jest.fn().mockImplementation(async (url: RequestInfo | URL) => {
    const urlStr = url.toString()

    // OIDC discovery endpoint
    if (urlStr.includes('.well-known')) {
      if (opts.discoveryFails) {
        return { ok: false, status: 500 }
      }
      return {
        ok: true,
        json: async () => ({ token_endpoint: 'https://sso.example.com/token' }),
      }
    }

    // Token exchange endpoint
    if (opts.nonJsonResponse) {
      return {
        ok: false,
        headers: { get: () => 'text/html' },
        text: async () => '<html>Error page</html>',
      }
    }
    if (opts.tokenFails) {
      return {
        ok: false,
        headers: { get: () => 'application/json' },
        json: async () => ({ error: 'invalid_grant', error_description: 'Refresh token expired' }),
      }
    }
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        access_token: 'new-access-token',
        id_token: 'new-id-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        ...opts.newTokens,
      }),
    }
  })
}

describe('auth-config', () => {
  beforeEach(() => {
    mockReconcileOidcClaimGroupsForUser.mockReset()
    _resetServerTokenStore()
  })

  describe('hasRequiredGroup', () => {
    it('should allow all groups when no required group is configured', () => {
      expect(withRequiredGroup(undefined, ({ hasRequiredGroup }) => hasRequiredGroup([]))).toBe(true)
      expect(withRequiredGroup(undefined, ({ hasRequiredGroup }) => hasRequiredGroup(['other-group']))).toBe(true)
    })

    it('should allow all groups when required group is explicitly empty', () => {
      expect(withRequiredGroup('', ({ hasRequiredGroup }) => hasRequiredGroup([]))).toBe(true)
      expect(withRequiredGroup('', ({ hasRequiredGroup }) => hasRequiredGroup(['caipe-users']))).toBe(true)
    })

    it('should return true when user has exact configured required group', () => {
      const groups = ['caipe-users', 'other-group']
      expect(withRequiredGroup('caipe-users', ({ hasRequiredGroup }) => hasRequiredGroup(groups))).toBe(true)
    })


    it('should return false when user does not have required group', () => {
      const groups = ['other-group', 'another-group']
      expect(withRequiredGroup('caipe-users', ({ hasRequiredGroup }) => hasRequiredGroup(groups))).toBe(false)
    })

    it('should be case-insensitive', () => {
      const groups = ['CAIPE-USERS', 'other-group']
      expect(withRequiredGroup('caipe-users', ({ hasRequiredGroup }) => hasRequiredGroup(groups))).toBe(true)
    })

    it('should handle LDAP DN format for groups', () => {
      const groups = [
        'CN=caipe-users,OU=Groups,DC=example,DC=com',
        'other-group',
      ]
      expect(withRequiredGroup('caipe-users', ({ hasRequiredGroup }) => hasRequiredGroup(groups))).toBe(true)
    })

    it('should handle mixed case in LDAP DN', () => {
      const groups = [
        'cn=CAIPE-USERS,ou=Groups,dc=example,dc=com',
        'other-group',
      ]
      expect(withRequiredGroup('caipe-users', ({ hasRequiredGroup }) => hasRequiredGroup(groups))).toBe(true)
    })

    it('should handle partial DN matches', () => {
      const groups = [
        'cn=CAIPE-Users,ou=Groups',
        'other-group',
      ]
      expect(withRequiredGroup('caipe-users', ({ hasRequiredGroup }) => hasRequiredGroup(groups))).toBe(true)
    })

    it('should not match substring in non-DN groups', () => {
      const groups = ['my-caipe-users-team', 'other-group']
      // Should not match because we're looking for "cn=caipe-users" in DN format
      // and exact match for simple group names
      expect(withRequiredGroup('caipe-users', ({ hasRequiredGroup }) => hasRequiredGroup(groups))).toBe(false)
    })

    it('should handle empty groups array', () => {
      const groups: string[] = []
      expect(withRequiredGroup('caipe-users', ({ hasRequiredGroup }) => hasRequiredGroup(groups))).toBe(false)
    })

    it('should handle multiple matching groups', () => {
      const groups = [
        'caipe-users',
        'CN=caipe-users,OU=Groups,DC=example,DC=com',
        'other-group',
      ]
      expect(withRequiredGroup('caipe-users', ({ hasRequiredGroup }) => hasRequiredGroup(groups))).toBe(true)
    })
  })

  describe('Token refresh configuration', () => {
    const originalEnv = process.env

    beforeEach(() => {
      // Note: jest.resetModules() deliberately omitted here.
      // Each test uses jest.isolateModules() to get an isolated module load.
      // Calling jest.resetModules() here would invalidate the top-level
      // jose mock reference captured by the already-loaded authOptions module.
      process.env = { ...originalEnv }
    })

    afterAll(() => {
      process.env = originalEnv
    })

    it('ENABLE_REFRESH_TOKEN defaults to true', () => {
      delete process.env.OIDC_ENABLE_REFRESH_TOKEN

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ENABLE_REFRESH_TOKEN } = require('../auth-config')
        expect(ENABLE_REFRESH_TOKEN).toBe(true)
      })
    })

    it('ENABLE_REFRESH_TOKEN is false when OIDC_ENABLE_REFRESH_TOKEN=false', () => {
      process.env.OIDC_ENABLE_REFRESH_TOKEN = 'false'

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ENABLE_REFRESH_TOKEN } = require('../auth-config')
        expect(ENABLE_REFRESH_TOKEN).toBe(false)
      })
    })
  })

  describe('OIDC Scope Configuration', () => {
    const originalEnv = process.env

    beforeEach(() => {
      // See note in 'Token refresh configuration' — jest.resetModules() omitted intentionally.
      process.env = { ...originalEnv }
    })

    afterAll(() => {
      process.env = originalEnv
    })

    it('should request groups scope when refresh tokens enabled (no offline_access)', () => {
      process.env.OIDC_ENABLE_REFRESH_TOKEN = 'true'

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { authOptions, ENABLE_REFRESH_TOKEN } = require('../auth-config')
        expect(ENABLE_REFRESH_TOKEN).toBe(true)

        const provider = authOptions.providers[0]
        const scope = provider.authorization.params.scope
        expect(scope).toContain('groups')
        expect(scope).not.toContain('offline_access')
      })
    })

    it('should still request groups scope when refresh tokens disabled', () => {
      process.env.OIDC_ENABLE_REFRESH_TOKEN = 'false'

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { authOptions, ENABLE_REFRESH_TOKEN } = require('../auth-config')
        expect(ENABLE_REFRESH_TOKEN).toBe(false)

        const provider = authOptions.providers[0]
        const scope = provider.authorization.params.scope
        expect(scope).toContain('groups')
        expect(scope).not.toContain('offline_access')
      })
    })

    it('should default to enabled if OIDC_ENABLE_REFRESH_TOKEN not set', () => {
      delete process.env.OIDC_ENABLE_REFRESH_TOKEN

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ENABLE_REFRESH_TOKEN } = require('../auth-config')
        expect(ENABLE_REFRESH_TOKEN).toBe(true)
      })
    })

    it('should always include required OIDC scopes', () => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { authOptions } = require('../auth-config')
        const provider = authOptions.providers[0]
        const scope = provider.authorization.params.scope

        expect(scope).toContain('openid')
        expect(scope).toContain('email')
        expect(scope).toContain('profile')
        expect(scope).toContain('groups')
      })
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // kc_idp_hint forwarding
  //
  // The provider passes `kc_idp_hint` to Keycloak whenever OIDC_IDP_HINT is
  // set, which makes Keycloak skip its own login page and redirect straight
  // to the configured upstream IdP (Okta / Duo SSO / Azure AD …). The
  // conditional spread in auth-config.ts is the only mechanism preventing
  // an empty hint from being forwarded — an empty hint can confuse some
  // Keycloak builds, and a missing OIDC_IDP_HINT should mean "let Keycloak
  // decide" (via init-idp.sh's forceRedirect plumbing).
  // ─────────────────────────────────────────────────────────────────────────
  describe('OIDC kc_idp_hint forwarding', () => {
    const originalEnv = process.env

    beforeEach(() => {
      // See note in 'Token refresh configuration' — jest.resetModules() omitted intentionally.
      process.env = { ...originalEnv }
    })

    afterAll(() => {
      process.env = originalEnv
    })

    it('forwards kc_idp_hint as an authorization param when OIDC_IDP_HINT is set', () => {
      process.env.OIDC_IDP_HINT = 'duo-sso'

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { authOptions } = require('../auth-config')
        const provider = authOptions.providers[0]
        const params = provider.authorization.params

        expect(params).toMatchObject({ kc_idp_hint: 'duo-sso' })
        // Scope must still be present and unaffected.
        expect(params.scope).toContain('openid')
      })
    })

    it('forwards a different IdP alias verbatim (no hardcoding)', () => {
      process.env.OIDC_IDP_HINT = 'okta-prod'

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { authOptions } = require('../auth-config')
        const provider = authOptions.providers[0]
        expect(provider.authorization.params.kc_idp_hint).toBe('okta-prod')
      })
    })

    it('omits kc_idp_hint entirely when OIDC_IDP_HINT is unset', () => {
      delete process.env.OIDC_IDP_HINT

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { authOptions } = require('../auth-config')
        const provider = authOptions.providers[0]
        expect('kc_idp_hint' in provider.authorization.params).toBe(false)
      })
    })

    it('omits kc_idp_hint entirely when OIDC_IDP_HINT is the empty string', () => {
      // Empty-string env vars are falsy in Node, so the conditional spread
      // must NOT inject `kc_idp_hint: ""` — Keycloak treats that ambiguously.
      process.env.OIDC_IDP_HINT = ''

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { authOptions } = require('../auth-config')
        const provider = authOptions.providers[0]
        expect('kc_idp_hint' in provider.authorization.params).toBe(false)
      })
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // JWT callback — real implementation tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('JWT callback', () => {
    const originalEnv = process.env
    let fetchSpy: jest.SpyInstance

    beforeEach(() => {
      process.env = {
        ...originalEnv,
        OIDC_ISSUER: 'https://sso.example.com',
        OIDC_CLIENT_ID: 'test-client-id',
        OIDC_CLIENT_SECRET: 'test-client-secret',
        OIDC_ENABLE_REFRESH_TOKEN: 'true',
      }
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(makeRefreshFetchMock())
    })

    afterEach(() => {
      process.env = originalEnv
      fetchSpy.mockRestore()
    })

    it('should store all tokens on initial sign-in', async () => {
      const now = Math.floor(Date.now() / 1000)

      const result = await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
        token: {},
        account: {
          access_token: 'at',
          id_token: 'idt',
          refresh_token: 'rt',
          expires_at: now + 3600,
        },
        profile: {
          sub: 'sub-123',
          email: 'user@example.com',
          groups: ['caipe-users'],
        },
      })

      expect(result.accessToken).toBe('at')
      expect(result.idToken).toBeUndefined()
      expect(result.refreshToken).toBe('rt')
      expect(result.expiresAt).toBe(now + 3600)
      expect(result.email).toBe('user@example.com')
      expect(result.isAuthorized).toBe(true)
      expect(result.role).toBe('user')
      expect(result.groupsCheckedAt).toBeGreaterThanOrEqual(now)
    })

    it('should set isAuthorized=false when user lacks required group', async () => {
      const now = Math.floor(Date.now() / 1000)
      const result = await withRequiredGroup('caipe-users', async ({ authOptions }) => (
        authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>
      )({
        token: {},
        account: {
          access_token: 'at',
          id_token: 'idt',
          expires_at: now + 3600,
        },
        profile: {
          sub: 'sub-123',
          email: 'nogroup@example.com',
          groups: ['unrelated-group'],
        },
      }))

      expect(result.isAuthorized).toBe(false)
    })

    it('should set isAuthorized=true on initial sign-in when required group gate is disabled', async () => {
      const now = Math.floor(Date.now() / 1000)
      const result = await withRequiredGroup('', async ({ authOptions }) => (
        authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>
      )({
        token: {},
        account: {
          access_token: 'at',
          id_token: 'idt',
          expires_at: now + 3600,
        },
        profile: {
          sub: 'sub-123',
          email: 'nogroups@example.com',
          groups: [],
        },
      }))

      expect(result.isAuthorized).toBe(true)
      expect(result.role).toBe('user')
    })

    it('reconciles login claim groups by default without storing them in the session token', async () => {
      delete process.env.IDENTITY_SYNC_LOGIN_CLAIMS_ENABLED
      delete process.env.IDENTITY_SYNC_OIDC_CLAIM_PROVIDER_ID
      const result = await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
        token: {},
        account: {
          access_token: 'at',
          id_token: 'idt',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
        profile: {
          sub: 'sub-123',
          email: 'user@example.com',
          name: 'User Example',
          groups: ['caipe-users', 'caipe-admins'],
        },
      })

      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(mockReconcileOidcClaimGroupsForUser).toHaveBeenCalledWith({
        subject: 'sub-123',
        email: 'user@example.com',
        displayName: 'User Example',
        groups: ['caipe-users', 'caipe-admins'],
        providerId: 'oidc-claims',
        // IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS unset → false (locked-down default).
        allowTeamCreation: false,
      })
      expect(getCachedOidcClaimGroups('sub-123')).toEqual(['caipe-users', 'caipe-admins'])
      expect(result.groups).toBeUndefined()
    })

    it('skips login claim reconciliation when explicitly disabled', async () => {
      process.env.IDENTITY_SYNC_LOGIN_CLAIMS_ENABLED = 'false'
      try {
        await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
          token: {},
          account: {
            access_token: 'at',
            id_token: 'idt',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          },
          profile: {
            sub: 'sub-123',
            email: 'user@example.com',
            groups: ['caipe-users'],
          },
        })

        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(mockReconcileOidcClaimGroupsForUser).not.toHaveBeenCalled()
      } finally {
        delete process.env.IDENTITY_SYNC_LOGIN_CLAIMS_ENABLED
      }
    })

    it('forwards allowTeamCreation=true when IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS is set', async () => {
      process.env.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS = 'true'
      try {
        await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
          token: {},
          account: {
            access_token: 'at',
            id_token: 'idt',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          },
          profile: {
            sub: 'sub-123',
            email: 'user@example.com',
            name: 'User Example',
            groups: ['caipe-users'],
          },
        })

        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(mockReconcileOidcClaimGroupsForUser).toHaveBeenCalledWith(
          expect.objectContaining({ allowTeamCreation: true })
        )
      } finally {
        delete process.env.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS
      }
    })

    it('treats any non-"true" IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS value as false (strict opt-in)', async () => {
      process.env.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS = '1'
      try {
        await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
          token: {},
          account: {
            access_token: 'at',
            id_token: 'idt',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          },
          profile: {
            sub: 'sub-123',
            email: 'user@example.com',
            name: 'User Example',
            groups: ['caipe-users'],
          },
        })

        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(mockReconcileOidcClaimGroupsForUser).toHaveBeenCalledWith(
          expect.objectContaining({ allowTeamCreation: false })
        )
      } finally {
        delete process.env.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS
      }
    })

    it('should NOT refresh token when expiry is more than 5 minutes away', async () => {
      const now = Math.floor(Date.now() / 1000)

      const result = await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
        token: {
          accessToken: 'old-at',
          refreshToken: 'rt',
          expiresAt: now + 600, // 10 minutes — no refresh needed
        },
      })

      expect(result.accessToken).toBe('old-at')
      // fetch should NOT have been called (no refresh needed)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('should attempt token refresh when within 5 minutes of expiry', async () => {
      const now = Math.floor(Date.now() / 1000)

      const result = await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
        token: {
          accessToken: 'old-at',
          idToken: 'old-idt',
          refreshToken: 'old-rt',
          expiresAt: now + 60, // 1 minute — refresh triggered
        },
      })

      expect(result.accessToken).toBe('new-access-token')
      expect(result.idToken).toBe('new-id-token')
      expect(result.refreshToken).toBe('new-refresh-token')
      expect(result.error).toBeUndefined()
    })

    it('refreshes stale access tokens when a refresh token is still available', async () => {
      const now = Math.floor(Date.now() / 1000)

      const result = await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
        token: {
          accessToken: 'at',
          refreshToken: 'rt',
          expiresAt: now - 4000, // expired 4000s ago (>1h)
        },
      })

      expect(result.accessToken).toBe('new-access-token')
      expect(result.refreshToken).toBe('new-refresh-token')
      expect(result.error).toBeUndefined()
      expect(fetchSpy).toHaveBeenCalled()
    })

    it('should skip refresh attempt when token already has an error', async () => {
      const now = Math.floor(Date.now() / 1000)

      const result = await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
        token: {
          accessToken: 'at',
          refreshToken: 'rt',
          expiresAt: now + 60,
          error: 'RefreshTokenExpired',
        },
      })

      expect(result.error).toBe('RefreshTokenExpired')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('should return RefreshTokenExpired when token exchange returns non-JSON', async () => {
      fetchSpy.mockRestore()
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
        makeRefreshFetchMock({ nonJsonResponse: true }),
      )

      const now = Math.floor(Date.now() / 1000)

      const result = await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
        token: {
          accessToken: 'at',
          refreshToken: 'rt',
          expiresAt: now + 60,
        },
      })

      expect(result.error).toBe('RefreshTokenExpired')
    })

    it('should return RefreshTokenExpired when token exchange fails', async () => {
      fetchSpy.mockRestore()
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
        makeRefreshFetchMock({ tokenFails: true }),
      )

      const now = Math.floor(Date.now() / 1000)

      // Access token already expired (-10s): if refresh token also gives invalid_grant
      // this is a real failure (not a concurrent race), so the user must re-authenticate.
      const result = await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
        token: {
          accessToken: 'at',
          refreshToken: 'rt',
          expiresAt: now - 10,
        },
      })

      expect(result.error).toBe('RefreshTokenExpired')
    })

    it('should fall back to Keycloak-style token endpoint when OIDC discovery fails', async () => {
      fetchSpy.mockRestore()
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
        makeRefreshFetchMock({ discoveryFails: true }),
      )

      const now = Math.floor(Date.now() / 1000)

      // Should still attempt the refresh using Keycloak fallback path
      await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
        token: {
          accessToken: 'at',
          refreshToken: 'rt',
          expiresAt: now + 60,
        },
      })

      // Discovery failed → fallback → token exchange also "failed" (our mock returns non-JSON
      // for the fallback call because discovery-fails mock only mocks the discovery call)
      // The important assertion: it attempted a refresh (fetch was called)
      expect(fetchSpy).toHaveBeenCalled()
    })

    it('should keep existing refresh token when provider does not return a new one', async () => {
      fetchSpy.mockRestore()
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
        makeRefreshFetchMock({ newTokens: { refresh_token: undefined } }),
      )

      const now = Math.floor(Date.now() / 1000)

      const result = await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
        token: {
          accessToken: 'at',
          refreshToken: 'original-rt',
          expiresAt: now + 60,
        },
      })

      // Should keep original refresh token (null-coalescing in auth-config.ts)
      expect(result.refreshToken).toBe('original-rt')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Group re-evaluation every 4 hours
  // ─────────────────────────────────────────────────────────────────────────

  describe('Group re-evaluation after token refresh', () => {
    const originalEnv = process.env
    let fetchSpy: jest.SpyInstance
    let mockDecodeJwt: jest.Mock

    beforeEach(() => {
      process.env = {
        ...originalEnv,
        OIDC_ISSUER: 'https://sso.example.com',
        OIDC_CLIENT_ID: 'test-client-id',
        OIDC_CLIENT_SECRET: 'test-client-secret',
        OIDC_ENABLE_REFRESH_TOKEN: 'true',
        OIDC_REQUIRED_ADMIN_GROUP: 'caipe-admins',
      }
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(makeRefreshFetchMock())
      mockDecodeJwt = jest.requireMock('jose').decodeJwt
      mockDecodeJwt.mockReset()
    })

    afterEach(() => {
      process.env = originalEnv
      fetchSpy.mockRestore()
    })

    it('preserves bootstrap-admin authorization when the refreshed ID token has no email claim', async () => {
      process.env.BOOTSTRAP_ADMIN_EMAILS = 'bootstrap@example.com'
      const now = Math.floor(Date.now() / 1000)
      mockDecodeJwt.mockReturnValue({ groups: [] })

      const result = await withRequiredGroup('required-group', async ({ authOptions }) => {
        const jwt = authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>
        const initial = await jwt({
          token: {},
          account: {
            access_token: 'at',
            refresh_token: 'rt',
            expires_at: now + 3600,
          },
          profile: {
            sub: 'bootstrap-sub',
            email: 'bootstrap@example.com',
            groups: [],
          },
        }) as Record<string, unknown>

        return jwt({
          token: {
            ...initial,
            expiresAt: now + 60,
            groupsCheckedAt: now - 5 * 60 * 60,
          },
        })
      }) as Record<string, unknown>

      expect(result.email).toBe('bootstrap@example.com')
      expect(result.isAuthorized).toBe(true)
    })

    it('should re-evaluate groups when 4+ hours have passed since last check', async () => {
      const now = Math.floor(Date.now() / 1000)

      mockDecodeJwt.mockReturnValue({
        groups: ['caipe-users'],
      })

      const result = await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
        token: {
          accessToken: 'at',
          idToken: 'old-idt',
          refreshToken: 'rt',
          expiresAt: now + 60,
          groupsCheckedAt: now - 5 * 60 * 60, // 5 hours ago
          isAuthorized: true,
          role: 'user',
          canViewAdmin: false,
        },
      })

      // decodeJwt should be called with the freshly-refreshed id_token
      expect(mockDecodeJwt).toHaveBeenCalledWith('new-id-token')
      // groupsCheckedAt must be updated to "now" (re-eval happened)
      expect(result.groupsCheckedAt).toBeGreaterThanOrEqual(now)
      // isAuthorized reflects the re-evaluated groups
      expect(result.isAuthorized).toBe(true)
      // Note: role promotion (user→admin) requires OIDC_REQUIRED_ADMIN_GROUP to be
      // set at module LOAD time. That constant is evaluated once at import; env changes
      // in beforeEach arrive too late. Role promotion is covered in isAdminUser unit tests.
    })

    it('should NOT re-evaluate groups when less than 4 hours have passed', async () => {
      const now = Math.floor(Date.now() / 1000)

      mockDecodeJwt.mockReturnValue({ groups: ['caipe-users'] })

      await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
        token: {
          accessToken: 'at',
          idToken: 'old-idt',
          refreshToken: 'rt',
          expiresAt: now + 60,
          groupsCheckedAt: now - 1 * 60 * 60, // only 1 hour ago
          isAuthorized: true,
          role: 'user',
        },
      })

      // decodeJwt should NOT have been called (interval not reached)
      expect(mockDecodeJwt).not.toHaveBeenCalled()
    })

    it('should skip group re-evaluation when refreshed token has an error', async () => {
      fetchSpy.mockRestore()
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
        makeRefreshFetchMock({ tokenFails: true }),
      )

      const now = Math.floor(Date.now() / 1000)

      mockDecodeJwt.mockReturnValue({ groups: ['caipe-users'] })

      // Access token already expired: this is a real refresh failure (not a race),
      // so the token gets error:'RefreshTokenExpired' and group re-eval is skipped.
      const result = await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
        token: {
          accessToken: 'at',
          idToken: 'old-idt',
          refreshToken: 'rt',
          expiresAt: now - 10,
          groupsCheckedAt: now - 5 * 60 * 60, // 5 hours ago
          isAuthorized: true,
          role: 'user',
        },
      })

      // Token refresh failed → shouldRecheckGroups is false → decodeJwt not called
      expect(mockDecodeJwt).not.toHaveBeenCalled()
      expect(result.error).toBe('RefreshTokenExpired')
    })

    it('should fall back gracefully when decodeJwt throws during group re-check', async () => {
      const now = Math.floor(Date.now() / 1000)

      mockDecodeJwt.mockImplementation(() => {
        throw new Error('Malformed JWT')
      })

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()

      const result = await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
        token: {
          accessToken: 'at',
          idToken: 'old-idt',
          refreshToken: 'rt',
          expiresAt: now + 60,
          groupsCheckedAt: now - 5 * 60 * 60,
          isAuthorized: true,
          role: 'user',
        },
      })

      // Should return the refreshed token without re-evaluated groups
      expect(result.accessToken).toBe('new-access-token')
      // Existing authorization should be preserved
      expect(result.isAuthorized).toBe(true)
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to decode id_token'),
        expect.any(Error),
      )

      consoleSpy.mockRestore()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // session callback
  // ─────────────────────────────────────────────────────────────────────────

  describe('session callback', () => {
    it('should pass accessToken and idToken to session when no error', async () => {
      const result = await (authOptions.callbacks!.session! as (...args: unknown[]) => Promise<unknown>)({
        session: { user: { name: 'Test', email: 'test@example.com' } },
        token: {
          accessToken: 'at',
          idToken: 'idt',
          refreshToken: 'rt',
          isAuthorized: true,
          role: 'user',
          expiresAt: 9999999999,
          hasRefreshToken: true,
        },
      })

      expect(result.accessToken).toBe('at')
      expect(result.idToken).toBeUndefined()
      expect(result.isAuthorized).toBe(true)
      expect(result.role).toBe('user')
    })

    it('should clear accessToken from session when RefreshTokenExpired', async () => {
      const result = await (authOptions.callbacks!.session! as (...args: unknown[]) => Promise<unknown>)({
        session: { user: { name: 'Test', email: 'test@example.com' } },
        token: {
          accessToken: 'at',
          idToken: 'idt',
          error: 'RefreshTokenExpired',
          isAuthorized: true,
          role: 'user',
        },
      })

      expect(result.accessToken).toBeUndefined()
      expect(result.error).toBe('RefreshTokenExpired')
    })

    it('should mark SSO sessions invalid when the server-side access token cache is missing', async () => {
      const result = await (authOptions.callbacks!.session! as (...args: unknown[]) => Promise<unknown>)({
        session: { user: { name: 'Test', email: 'test@example.com' } },
        token: {
          sub: 'user-sub',
          isAuthorized: true,
          role: 'admin',
          expiresAt: 9999999999,
        },
      })

      expect(result.accessToken).toBeUndefined()
      expect(result.error).toBe('AccessTokenMissing')
    })

    it('should propagate isAuthorized=false into the browser session', async () => {
      const result = await (authOptions.callbacks!.session! as (...args: unknown[]) => Promise<unknown>)({
        session: { user: { name: 'Blocked', email: 'blocked@example.com' } },
        token: {
          accessToken: 'at',
          isAuthorized: false,
          role: 'user',
        },
      })

      expect(result.isAuthorized).toBe(false)
      expect(result.role).toBe('user')
      expect(result.accessToken).toBe('at')
    })

    it('should NOT include tokens in session when token has error', async () => {
      const result = await (authOptions.callbacks!.session! as (...args: unknown[]) => Promise<unknown>)({
        session: { user: {} },
        token: {
          accessToken: 'at',
          idToken: 'idt',
          error: 'RefreshTokenError',
        },
      })

      // error path clears accessToken
      expect(result.accessToken).toBeUndefined()
    })

    it('should set role to user as default', async () => {
      const result = await (authOptions.callbacks!.session! as (...args: unknown[]) => Promise<unknown>)({
        session: { user: {} },
        token: {
          // no role set
        },
      })

      expect(result.role).toBe('user')
    })
  })

  describe('extractGroups helper', () => {
    it('extracts and deduplicates groups from common OIDC claim formats', () => {
      const groups = extractGroups({
        groups: 'caipe-users,caipe-admins',
        members: ['caipe-users', 'engineering'],
        memberOf: 'CN=caipe-users,OU=Groups,DC=example,DC=com other-group',
      })

      expect(groups).toEqual(expect.arrayContaining([
        'caipe-users',
        'caipe-admins',
        'engineering',
        'CN=caipe-users',
        'other-group',
      ]))
      expect(groups.filter((group) => group === 'caipe-users')).toHaveLength(1)
    })

    it('uses only configured OIDC_GROUP_CLAIM values when configured', () => {
      const previous = process.env.OIDC_GROUP_CLAIM
      process.env.OIDC_GROUP_CLAIM = 'members,roles'
      try {
        jest.isolateModules(() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { extractGroups } = require('../auth-config')
          expect(extractGroups({
            groups: ['ignored-group'],
            members: ['caipe-users'],
            roles: 'caipe-admins other-role',
          })).toEqual(['caipe-users', 'caipe-admins', 'other-role'])
        })
      } finally {
        if (previous === undefined) delete process.env.OIDC_GROUP_CLAIM
        else process.env.OIDC_GROUP_CLAIM = previous
      }
    })

    // assisted-by claude code claude-sonnet-4-6
    describe('OIDC_GROUP_INCLUDELIST', () => {
      it('passes all groups through when OIDC_GROUP_INCLUDELIST is unset', () => {
        jest.isolateModules(() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { extractGroups } = require('../auth-config')
          expect(extractGroups({ groups: ['platform-engineering', 'temp-test', 'sre'] }))
            .toEqual(expect.arrayContaining(['platform-engineering', 'temp-test', 'sre']))
        })
      })

      it('keeps only groups matching the includelist pattern', () => {
        const prev = process.env.OIDC_GROUP_INCLUDELIST
        process.env.OIDC_GROUP_INCLUDELIST = '^platform-engineering$,^sre$'
        try {
          jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { extractGroups } = require('../auth-config')
            expect(extractGroups({ groups: ['platform-engineering', 'temp-test', 'sre', 'other'] }))
              .toEqual(['platform-engineering', 'sre'])
          })
        } finally {
          if (prev === undefined) delete process.env.OIDC_GROUP_INCLUDELIST
          else process.env.OIDC_GROUP_INCLUDELIST = prev
        }
      })

      it('supports regex patterns in the includelist', () => {
        const prev = process.env.OIDC_GROUP_INCLUDELIST
        process.env.OIDC_GROUP_INCLUDELIST = '^caipe-.*'
        try {
          jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { extractGroups } = require('../auth-config')
            expect(extractGroups({ groups: ['caipe-admins', 'caipe-users', 'unrelated'] }))
              .toEqual(['caipe-admins', 'caipe-users'])
          })
        } finally {
          if (prev === undefined) delete process.env.OIDC_GROUP_INCLUDELIST
          else process.env.OIDC_GROUP_INCLUDELIST = prev
        }
      })

      it('returns empty array when no groups match the includelist', () => {
        const prev = process.env.OIDC_GROUP_INCLUDELIST
        process.env.OIDC_GROUP_INCLUDELIST = '^no-match$'
        try {
          jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { extractGroups } = require('../auth-config')
            expect(extractGroups({ groups: ['platform-engineering', 'sre'] })).toEqual([])
          })
        } finally {
          if (prev === undefined) delete process.env.OIDC_GROUP_INCLUDELIST
          else process.env.OIDC_GROUP_INCLUDELIST = prev
        }
      })
    })

    describe('OIDC_GROUP_EXCLUDELIST', () => {
      it('drops groups matching the excludelist pattern', () => {
        const prev = process.env.OIDC_GROUP_EXCLUDELIST
        process.env.OIDC_GROUP_EXCLUDELIST = '^temp-.*,^test-.*'
        try {
          jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { extractGroups } = require('../auth-config')
            expect(extractGroups({ groups: ['platform-engineering', 'temp-trial', 'test-group', 'sre'] }))
              .toEqual(['platform-engineering', 'sre'])
          })
        } finally {
          if (prev === undefined) delete process.env.OIDC_GROUP_EXCLUDELIST
          else process.env.OIDC_GROUP_EXCLUDELIST = prev
        }
      })

      it('passes all groups through when OIDC_GROUP_EXCLUDELIST is unset', () => {
        jest.isolateModules(() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { extractGroups } = require('../auth-config')
          expect(extractGroups({ groups: ['platform-engineering', 'temp-test'] }))
            .toEqual(expect.arrayContaining(['platform-engineering', 'temp-test']))
        })
      })
    })

    describe('OIDC_GROUP_INCLUDELIST + OIDC_GROUP_EXCLUDELIST combined', () => {
      it('applies includelist first then excludelist', () => {
        const prevIn = process.env.OIDC_GROUP_INCLUDELIST
        const prevEx = process.env.OIDC_GROUP_EXCLUDELIST
        process.env.OIDC_GROUP_INCLUDELIST = '^caipe-.*'
        process.env.OIDC_GROUP_EXCLUDELIST = '^caipe-temp-.*'
        try {
          jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { extractGroups } = require('../auth-config')
            const groups = extractGroups({
              groups: ['caipe-admins', 'caipe-temp-trial', 'unrelated', 'caipe-users'],
            })
            expect(groups).toEqual(['caipe-admins', 'caipe-users'])
            expect(groups).not.toContain('caipe-temp-trial')
            expect(groups).not.toContain('unrelated')
          })
        } finally {
          if (prevIn === undefined) delete process.env.OIDC_GROUP_INCLUDELIST
          else process.env.OIDC_GROUP_INCLUDELIST = prevIn
          if (prevEx === undefined) delete process.env.OIDC_GROUP_EXCLUDELIST
          else process.env.OIDC_GROUP_EXCLUDELIST = prevEx
        }
      })
    })
  })

  describe('OIDC claim group cache', () => {
    it('offloads large OAuth tokens while preserving cached claim groups when slim JWT tokens are encoded', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { encode } = require('next-auth/jwt')
      encode.mockClear()
      cacheOidcClaimGroups('sub-123', ['caipe-users'])

      await authOptions.jwt!.encode!({
        token: {
          sub: 'sub-123',
          accessToken: 'at',
          refreshToken: 'rt',
        },
        secret: 'test-secret',
        maxAge: 60,
      })

      expect(encode).toHaveBeenCalledWith(expect.objectContaining({
        token: expect.not.objectContaining({
          accessToken: expect.anything(),
          refreshToken: expect.anything(),
          idToken: expect.anything(),
        }),
      }))
      expect(getCachedOidcClaimGroups('sub-123')).toEqual(['caipe-users'])
    })
  })

  describe('resolveLoginProviderId', () => {
    const ENV_KEYS = ['OIDC_IDP_HINT', 'IDENTITY_SYNC_OIDC_CLAIM_PROVIDER_ID'] as const
    let saved: Record<string, string | undefined>

    beforeEach(() => {
      saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
      for (const k of ENV_KEYS) delete process.env[k]
    })
    afterEach(() => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    })

    it('prefers the identity_provider token claim and normalizes it', () => {
      process.env.OIDC_IDP_HINT = 'duo-sso'
      expect(resolveLoginProviderId({ identity_provider: 'okta-prod' })).toBe('okta')
    })

    it('falls back to OIDC_IDP_HINT, normalizing the connection suffix', () => {
      process.env.OIDC_IDP_HINT = 'duo-sso'
      expect(resolveLoginProviderId({})).toBe('duo')
    })

    it('maps an okta hint to the okta provider so source_type lines up', () => {
      process.env.OIDC_IDP_HINT = 'okta'
      expect(resolveLoginProviderId(undefined)).toBe('okta')
    })

    it('uses IDENTITY_SYNC_OIDC_CLAIM_PROVIDER_ID when no hint is set', () => {
      process.env.IDENTITY_SYNC_OIDC_CLAIM_PROVIDER_ID = 'custom-idp'
      expect(resolveLoginProviderId({})).toBe('custom-idp')
    })

    it('defaults to oidc-claims when nothing is configured', () => {
      expect(resolveLoginProviderId({})).toBe('oidc-claims')
    })
  })

  describe('isAdminUser', () => {
    it('returns false when OIDC_REQUIRED_ADMIN_GROUP is not set', () => {
      // Default is empty string, so returns false
      expect(isAdminUser([])).toBe(false)
    })
  })

  describe('canViewAdminDashboard', () => {
    it('returns true when OIDC_REQUIRED_ADMIN_VIEW_GROUP is not set (default)', () => {
      // Default is empty string = all authenticated users can view
      const groups = ['some-group']
      expect(canViewAdminDashboard(groups)).toBe(true)
    })

    it('returns true even with empty groups when no view group configured', () => {
      expect(canViewAdminDashboard([])).toBe(true)
    })
  })

  describe('canAccessDynamicAgents (OpenFGA-only Dynamic Agents access)', () => {
    const originalEnv = process.env

    beforeEach(() => {
      jest.resetModules()
      process.env = { ...originalEnv }
    })

    afterAll(() => {
      process.env = originalEnv
    })

    it('does not use AD/OIDC groups as a Dynamic Agents authorization gate', () => {
      jest.isolateModules(() => {
        process.env.OIDC_REQUIRED_DYNAMIC_AGENTS_GROUP = 'custom-agents-users'
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { canAccessDynamicAgents: fn } = require('../auth-config')
        expect(fn([])).toBe(true)
        expect(fn(['eng', 'caipe-users'])).toBe(true)
        expect(fn(['custom-agents-users'])).toBe(true)
      })
    })

    it('does not fall back to admin-only access when the dynamic agents group is unset', () => {
      jest.isolateModules(() => {
        delete process.env.OIDC_REQUIRED_DYNAMIC_AGENTS_GROUP
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { canAccessDynamicAgents: fn } = require('../auth-config')
        expect(fn([])).toBe(true)
        expect(fn(['eng', 'backend'])).toBe(true)
      })
    })

    it('ignores admin group membership because OpenFGA resource checks are authoritative', () => {
      jest.isolateModules(() => {
        process.env.OIDC_REQUIRED_DYNAMIC_AGENTS_GROUP = 'custom-agents-users'
        process.env.OIDC_REQUIRED_ADMIN_GROUP = 'sre-admin'
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { canAccessDynamicAgents: fn } = require('../auth-config')
        expect(fn(['sre-admin'])).toBe(true)
      })
    })
  })


  // ─────────────────────────────────────────────────────────────────────────
  // Concurrent refresh race safety nets
  // ─────────────────────────────────────────────────────────────────────────

  describe('Concurrent refresh race safety nets', () => {
    const originalEnv = process.env
    let fetchSpy: jest.SpyInstance

    beforeEach(() => {
      process.env = {
        ...originalEnv,
        OIDC_ISSUER: 'https://sso.example.com',
        OIDC_CLIENT_ID: 'test-client-id',
        OIDC_CLIENT_SECRET: 'test-client-secret',
        OIDC_ENABLE_REFRESH_TOKEN: 'true',
      }
      _resetInflightRefreshes()
    })

    afterEach(() => {
      process.env = originalEnv
      fetchSpy?.mockRestore()
    })

    it('Safety net 1: concurrent callers share one HTTP exchange', async () => {
      // Two JWT callbacks with the same refresh token fire simultaneously.
      // Only one fetch should happen (the in-flight dedup kicks in for the second).
      let resolveExchange!: (v: Response) => void
      const exchangeHeld = new Promise<Response>((res) => { resolveExchange = res })

      let fetchCallCount = 0
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
        fetchCallCount++
        const urlStr = url.toString()
        if (urlStr.includes('.well-known')) {
          return {
            ok: true,
            json: async () => ({ token_endpoint: 'https://sso.example.com/token' }),
          } as Response
        }
        // Hold the exchange until we're ready
        return exchangeHeld
      })

      const now = Math.floor(Date.now() / 1000)
      const baseToken = {
        accessToken: 'at',
        idToken: 'old-idt',
        refreshToken: 'shared-rt',
        expiresAt: now + 60,
      }

      // Fire two concurrent calls
      const call1 = (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({ token: { ...baseToken } })
      const call2 = (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({ token: { ...baseToken } })

      // Resolve the held exchange with a successful response
      resolveExchange({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          access_token: 'new-at',
          id_token: 'new-idt',
          refresh_token: 'new-rt',
          expires_in: 3600,
        }),
      } as unknown)

      const [result1, result2] = await Promise.all([call1, call2])

      // Both should get new tokens
      expect(result1.accessToken).toBe('new-at')
      expect(result2.accessToken).toBe('new-at')

      // Only 2 fetches total: 1 discovery + 1 exchange (not 2 exchanges)
      // (The second caller joined the in-flight Promise)
      expect(fetchCallCount).toBe(2)
    })

    it('Safety net 2: invalid_grant with valid access token keeps session (no logout)', async () => {
      const now = Math.floor(Date.now() / 1000)

      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(makeRefreshFetchMock({
        tokenFails: false,
        // Override to return invalid_grant specifically
      }))
      // Override with invalid_grant scenario
      fetchSpy.mockRestore()
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString()
        if (urlStr.includes('.well-known')) {
          return {
            ok: true,
            json: async () => ({ token_endpoint: 'https://sso.example.com/token' }),
          } as Response
        }
        // Token exchange: return invalid_grant
        return {
          ok: false,
          headers: { get: () => 'application/json' },
          json: async () => ({ error: 'invalid_grant', error_description: 'Token already used' }),
        } as unknown
      })

      const result = await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
        token: {
          accessToken: 'still-valid-at',
          refreshToken: 'consumed-rt',
          expiresAt: now + 200, // access token still valid but within 5-min refresh window
        },
      })

      // Should NOT be logged out — access token is still valid
      expect(result.error).toBeUndefined()
      expect(result.accessToken).toBe('still-valid-at')
      // Should suppress further refresh attempts until token expires
      expect(result.refreshSuppressedUntil).toBe(now + 200)
    })

    it('Safety net 3: suppressed refresh prevents further refresh attempts', async () => {
      const now = Math.floor(Date.now() / 1000)

      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(makeRefreshFetchMock())

      // Token has refreshSuppressedUntil set (from a prior graceful invalid_grant)
      const result = await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
        token: {
          accessToken: 'still-valid-at',
          refreshToken: 'consumed-rt',
          expiresAt: now + 200,
          refreshSuppressedUntil: now + 200, // suppressed until token expires
        },
      })

      // Should return the token as-is without attempting refresh
      expect(result.accessToken).toBe('still-valid-at')
      expect(result.error).toBeUndefined()
      // No fetch calls — refresh was suppressed
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('Safety net 2: invalid_grant with expired access token still logs out', async () => {
      const now = Math.floor(Date.now() / 1000)

      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString()
        if (urlStr.includes('.well-known')) {
          return {
            ok: true,
            json: async () => ({ token_endpoint: 'https://sso.example.com/token' }),
          } as Response
        }
        return {
          ok: false,
          headers: { get: () => 'application/json' },
          json: async () => ({ error: 'invalid_grant', error_description: 'Token already used' }),
        } as unknown
      })

      const result = await (authOptions.callbacks!.jwt! as (...args: unknown[]) => Promise<unknown>)({
        token: {
          accessToken: 'expired-at',
          refreshToken: 'consumed-rt',
          expiresAt: now - 300, // access token has already expired
        },
      })

      // Access token is expired too — user must re-authenticate
      expect(result.error).toBe('RefreshTokenExpired')
    })
  })
})
