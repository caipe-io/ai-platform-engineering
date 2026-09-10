/**
 * assisted-by Codex Codex-sonnet-4-6
 *
 * Unit tests for TokenExpiryGuard component
 *
 * Tests cover:
 * - Token expiry monitoring and warning display
 * - Dismiss button persistence (stays dismissed for the same expiry cycle)
 * - Silent token auto-refresh via updateSession
 * - Expired token handling and auto-redirect
 * - Warning message changes based on refresh token availability
 * - "Sign in again" clears the stale session and preserves return path
 * - "Sign In Again" on expired modal signs out and clears flag
 * - Auto-logout after 5-second countdown
 * - Concurrent refresh lock (only one refresh attempt at a time)
 * - Cleanup on unmount
 *
 * assisted-by Codex Codex-sonnet-4-6
 */

import React from 'react'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { useSession, signOut } from 'next-auth/react'
import { TokenExpiryGuard } from '../token-expiry-guard'

// Mock Next Auth
const mockUpdateSession = jest.fn().mockResolvedValue(undefined)

jest.mock('next-auth/react', () => ({
  useSession: jest.fn(),
  signOut: jest.fn(),
}))

// Mock config
jest.mock('@/lib/config', () => ({
  getConfig: jest.fn((key: string) => {
    if (key === 'ssoEnabled') return true
    return undefined
  }),
}))

// Mock framer-motion to avoid animation issues in tests
jest.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))

describe('TokenExpiryGuard', () => {
  const mockSignOut = signOut as jest.MockedFunction<typeof signOut>
  const mockUseSession = useSession as jest.MockedFunction<typeof useSession>
  let mockWindowOpen: jest.Mock

  // Mock sessionStorage
  let sessionStorageData: Record<string, string> = {}
  const mockSessionStorage = {
    getItem: jest.fn((key: string) => sessionStorageData[key] ?? null),
    setItem: jest.fn((key: string, value: string) => { sessionStorageData[key] = value }),
    removeItem: jest.fn((key: string) => { delete sessionStorageData[key] }),
    clear: jest.fn(() => { sessionStorageData = {} }),
  }

  beforeEach(() => {
    jest.restoreAllMocks()
    jest.useFakeTimers()
    mockUpdateSession.mockClear().mockResolvedValue(undefined)
    sessionStorageData = {}

    Object.defineProperty(window, 'sessionStorage', { value: mockSessionStorage, writable: true })
    window.history.pushState({}, '', '/')

    // Mock window.open
    mockWindowOpen = jest.fn()
    Object.defineProperty(window, 'open', { value: mockWindowOpen, writable: true })

    // Reset getConfig mock to default (ssoEnabled = true)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getConfig } = require('@/lib/config')
    getConfig.mockImplementation((key: string) => {
      if (key === 'ssoEnabled') return true
      return undefined
    })

    mockSignOut.mockClear().mockResolvedValue(undefined as unknown)
  })

  afterEach(() => {
    // Only run pending timers if fake timers are active
    try { jest.runOnlyPendingTimers() } catch { /* real timers active */ }
    jest.useRealTimers()
  })

  // ─────────────────────────────────────────────────────────────────────
  // Basic rendering
  // ─────────────────────────────────────────────────────────────────────

  it('should render nothing when SSO is not enabled', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getConfig } = require('@/lib/config')
    getConfig.mockReturnValue(false)

    mockUseSession.mockReturnValue({
      data: null,
      status: 'unauthenticated',
    } as unknown)

    const { container } = render(<TokenExpiryGuard />)
    expect(container.firstChild).toBeNull()
  })

  it('should render nothing when not authenticated', () => {
    mockUseSession.mockReturnValue({
      data: null,
      status: 'unauthenticated',
    } as unknown)

    const { container } = render(<TokenExpiryGuard />)
    expect(container.firstChild).toBeNull()
  })

  it('should render nothing when session is loading', () => {
    mockUseSession.mockReturnValue({
      data: null,
      status: 'loading',
    } as unknown)

    const { container } = render(<TokenExpiryGuard />)
    expect(container.firstChild).toBeNull()
  })

  // ─────────────────────────────────────────────────────────────────────
  // Warning display
  // ─────────────────────────────────────────────────────────────────────

  it('should not show warning when token has plenty of time remaining', () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 600 // 10 minutes from now

    mockUseSession.mockReturnValue({
      data: {
        user: { name: 'Test User', email: 'test@example.com' },
        expiresAt: futureExpiry,
      } as unknown,
      status: 'authenticated',
      update: mockUpdateSession,
    })

    render(<TokenExpiryGuard />)

    // Advance timer by 30 seconds (one check cycle)
    act(() => {
      jest.advanceTimersByTime(30000)
    })

    // Should not show any warnings
    expect(screen.queryByText(/session expiring soon/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument()
    expect(mockSignOut).not.toHaveBeenCalled()
  })

  it('should not call signOut when token expires soon (warning only)', async () => {
    const soonExpiry = Math.floor(Date.now() / 1000) + 240 // 4 minutes from now

    mockUseSession.mockReturnValue({
      data: {
        user: { name: 'Test User', email: 'test@example.com' },
        expiresAt: soonExpiry,
      } as unknown,
      status: 'authenticated',
      update: mockUpdateSession,
    })

    render(<TokenExpiryGuard />)

    // Wait for mount
    await act(async () => {
      jest.advanceTimersByTime(0)
    })

    // Trigger warning check
    await act(async () => {
      jest.advanceTimersByTime(30000)
    })

    // Should NOT call signOut yet (just warning)
    expect(mockSignOut).not.toHaveBeenCalled()
  })

  it('should cleanup interval on unmount', () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 600

    mockUseSession.mockReturnValue({
      data: {
        user: { name: 'Test User', email: 'test@example.com' },
        expiresAt: futureExpiry,
      } as unknown,
      status: 'authenticated',
      update: mockUpdateSession,
    })

    const { unmount } = render(<TokenExpiryGuard />)
    const mountedTimerCount = jest.getTimerCount()
    expect(mountedTimerCount).toBeGreaterThan(0)

    unmount()
    expect(jest.getTimerCount()).toBeLessThan(mountedTimerCount)
  })

  // ─────────────────────────────────────────────────────────────────────
  // Sign in again button
  // ─────────────────────────────────────────────────────────────────────

  describe('Sign in again button', () => {
    it('should sign out with current page preserved as callbackUrl when clicked', async () => {
      jest.useRealTimers()
      window.history.pushState({}, '', '/apps/embed/kaleidoscope?view=study#report')
      const soonExpiry = Math.floor(Date.now() / 1000) + 240

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          expiresAt: soonExpiry,
          hasRefreshToken: false,
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      await waitFor(() => {
        expect(screen.getByText(/session expiring soon/i)).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText(/sign in again/i))

      await waitFor(() => {
        expect(mockSignOut).toHaveBeenCalledWith({
          callbackUrl:
            '/login?session_expired=true&callbackUrl=%2Fapps%2Fembed%2Fkaleidoscope%3Fview%3Dstudy%23report',
        })
      })
    })

    it('should set the expiry-handling flag before redirecting to login', async () => {
      jest.useRealTimers()
      const soonExpiry = Math.floor(Date.now() / 1000) + 240

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          expiresAt: soonExpiry,
          hasRefreshToken: false,
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      await waitFor(() => {
        expect(screen.getByText(/session expiring soon/i)).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText(/sign in again/i))

      expect(mockSessionStorage.setItem).toHaveBeenCalledWith('token-expiry-handling', 'true')
    })

    it('should not use the brittle new-tab refresh flow', async () => {
      jest.useRealTimers()
      const soonExpiry = Math.floor(Date.now() / 1000) + 240

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          expiresAt: soonExpiry,
          hasRefreshToken: false,
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      await waitFor(() => {
        expect(screen.getByText(/session expiring soon/i)).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText(/sign in again/i))

      expect(mockWindowOpen).not.toHaveBeenCalled()
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // Dismiss persistence tests
  // ─────────────────────────────────────────────────────────────────────

  describe('dismiss persistence', () => {
    it('should keep warning dismissed after clicking Dismiss (same expiry cycle)', async () => {
      jest.useRealTimers() // Use real timers so async flows resolve naturally
      const soonExpiry = Math.floor(Date.now() / 1000) + 240 // 4 minutes from now

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          expiresAt: soonExpiry,
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      // Wait for warning to appear (checkTokenExpiry runs on mount via useEffect)
      await waitFor(() => {
        expect(screen.getByText(/session expiring soon/i)).toBeInTheDocument()
      })

      // Click Dismiss
      fireEvent.click(screen.getByText('Dismiss'))

      // Warning should disappear
      expect(screen.queryByText(/session expiring soon/i)).not.toBeInTheDocument()
    })

    it('should show warning again after token is refreshed (new expiry cycle)', async () => {
      jest.useRealTimers()
      const soonExpiry = Math.floor(Date.now() / 1000) + 240 // 4 minutes from now

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          expiresAt: soonExpiry,
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      const { rerender } = render(<TokenExpiryGuard />)

      // Wait for warning to appear
      await waitFor(() => {
        expect(screen.getByText(/session expiring soon/i)).toBeInTheDocument()
      })

      // Dismiss
      fireEvent.click(screen.getByText('Dismiss'))
      expect(screen.queryByText(/session expiring soon/i)).not.toBeInTheDocument()

      // Simulate token refresh — new expiresAt (different value = new expiry cycle)
      const newExpiry = Math.floor(Date.now() / 1000) + 200

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          expiresAt: newExpiry,
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      rerender(<TokenExpiryGuard />)

      // Warning should reappear for the new expiry cycle
      await waitFor(() => {
        expect(screen.getByText(/session expiring soon/i)).toBeInTheDocument()
      })
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // Silent auto-refresh tests
  // ─────────────────────────────────────────────────────────────────────

  describe('silent auto-refresh', () => {
    it('should call updateSession when token is within warning window and refresh token exists', async () => {
      jest.useRealTimers()
      const soonExpiry = Math.floor(Date.now() / 1000) + 240 // 4 minutes from now

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          expiresAt: soonExpiry,
          hasRefreshToken: true,
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      // Wait for the warning to appear (which means checkTokenExpiry ran)
      await waitFor(() => {
        expect(screen.getByText(/session expiring soon/i)).toBeInTheDocument()
      })

      // updateSession should have been called (silent refresh triggered on mount)
      expect(mockUpdateSession).toHaveBeenCalled()
    })

    it('should NOT call updateSession when token has plenty of time remaining', async () => {
      jest.useRealTimers()
      const futureExpiry = Math.floor(Date.now() / 1000) + 600 // 10 min from now

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          expiresAt: futureExpiry,
          hasRefreshToken: true,
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      // Wait a tick for effects to settle
      await waitFor(() => {
        // No warning should appear (token not near expiry)
        expect(screen.queryByText(/session expiring soon/i)).not.toBeInTheDocument()
      })

      // Should NOT have called updateSession (token not near expiry)
      expect(mockUpdateSession).not.toHaveBeenCalled()
    })

    it('should show auto-refresh message when hasRefreshToken is true', async () => {
      jest.useRealTimers()
      const soonExpiry = Math.floor(Date.now() / 1000) + 240

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          expiresAt: soonExpiry,
          hasRefreshToken: true,
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      // Wait for warning to appear
      await waitFor(() => {
        expect(screen.getByText(/attempting to refresh automatically/i)).toBeInTheDocument()
      })
    })

    it('should show manual re-login message when hasRefreshToken is false', async () => {
      jest.useRealTimers()
      const soonExpiry = Math.floor(Date.now() / 1000) + 240

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          expiresAt: soonExpiry,
          hasRefreshToken: false,
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      // Wait for warning to appear
      await waitFor(() => {
        expect(screen.getByText(/please re-login to continue/i)).toBeInTheDocument()
      })

      expect(screen.queryByText(/attempting to refresh automatically/i)).not.toBeInTheDocument()
    })

    it('should tolerate a single silent-refresh failure without logging out', async () => {
      // Regression test: a lone transient failure (network blip, momentary
      // server-side cache miss, etc.) must NOT tear down the session while
      // the token still has plenty of time left — the whole point of the
      // "Attempting to refresh automatically..." banner is that it keeps
      // trying, not that it gives up on the very first hiccup.
      const soonExpiry = Math.floor(Date.now() / 1000) + 240
      mockUpdateSession.mockRejectedValueOnce(new Error('Network error'))

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation()

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          expiresAt: soonExpiry,
          hasRefreshToken: true,
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      // Mount triggers the proactive silent refresh, which rejects once.
      await act(async () => { jest.advanceTimersByTime(0) })

      expect(screen.queryByText(/sign-in needed/i)).not.toBeInTheDocument()
      expect(mockSignOut).not.toHaveBeenCalled()
      expect(screen.getByText(/session expiring soon/i)).toBeInTheDocument()

      consoleSpy.mockRestore()
    })

    it('should force logout only after the token has expired and repeated refresh retries are exhausted', async () => {
      window.history.pushState({}, '', '/apps/embed/kaleidoscope?view=study#report')
      const pastExpiry = Math.floor(Date.now() / 1000) - 1 // already expired
      mockUpdateSession.mockRejectedValue(new Error('Network error')) // always fails

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation()

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          expiresAt: pastExpiry,
          hasRefreshToken: true,
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      // Tick 1 (mount): expired reading #1 — still within the retry budget.
      await act(async () => { jest.advanceTimersByTime(0) })
      expect(screen.queryByText(/redirecting to login/i)).not.toBeInTheDocument()

      // Tick 2 (+30s): expired reading #2 — still within the retry budget.
      await act(async () => { jest.advanceTimersByTime(30000) })
      expect(screen.queryByText(/redirecting to login/i)).not.toBeInTheDocument()
      expect(mockSignOut).not.toHaveBeenCalled()

      // Tick 3 (+30s): retry budget exhausted — now forces logout.
      await act(async () => { jest.advanceTimersByTime(30000) })
      await waitFor(() => {
        expect(screen.getByText(/session expired/i)).toBeInTheDocument()
        expect(screen.getByText(/redirecting to login in 5 seconds/i)).toBeInTheDocument()
      })

      await act(async () => { jest.advanceTimersByTime(5000) })
      expect(mockSignOut).toHaveBeenCalledWith({
        callbackUrl: '/login?session_expired=true&callbackUrl=%2Fapps%2Fembed%2Fkaleidoscope%3Fview%3Dstudy%23report',
      })

      consoleSpy.mockRestore()
    })

    it('should not start a second refresh while first is in flight (concurrent lock)', async () => {
      // Use fake timers so we can control the 30s interval
      // mockUpdateSession never resolves for this test, keeping isRefreshingRef = true
      let resolveFirstRefresh!: () => void
      mockUpdateSession.mockReturnValue(
        new Promise<unknown>((resolve) => { resolveFirstRefresh = resolve }),
      )

      const soonExpiry = Math.floor(Date.now() / 1000) + 240

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          expiresAt: soonExpiry,
          hasRefreshToken: true,
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      // Initial mount check triggers the first refresh (never resolves)
      await act(async () => { jest.advanceTimersByTime(0) })

      expect(mockUpdateSession).toHaveBeenCalledTimes(1)

      // 30s interval fires — first refresh is still in flight
      await act(async () => { jest.advanceTimersByTime(30000) })

      // updateSession should still be called only once (lock prevents second call)
      expect(mockUpdateSession).toHaveBeenCalledTimes(1)

      // Resolve first refresh to clean up
      act(() => { resolveFirstRefresh() })
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // Refresh token error handling
  // ─────────────────────────────────────────────────────────────────────

  describe('refresh token errors', () => {
    it('should set token-expiry-handling flag when RefreshTokenExpired', async () => {
      jest.useRealTimers()

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          error: 'RefreshTokenExpired',
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      await waitFor(() => {
        expect(mockSessionStorage.setItem).toHaveBeenCalledWith('token-expiry-handling', 'true')
      })
    })

    it('should set token-expiry-handling flag when RefreshTokenError', async () => {
      jest.useRealTimers()

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          error: 'RefreshTokenError',
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      await waitFor(() => {
        expect(mockSessionStorage.setItem).toHaveBeenCalledWith('token-expiry-handling', 'true')
      })
    })

    it('should set token-expiry-handling flag when the server-side access token cache is missing', async () => {
      jest.useRealTimers()

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          error: 'AccessTokenMissing',
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      await waitFor(() => {
        expect(mockSessionStorage.setItem).toHaveBeenCalledWith('token-expiry-handling', 'true')
      })
    })

    it('should show refresh-failed modal when session has RefreshTokenExpired error', async () => {
      jest.useRealTimers()

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          error: 'RefreshTokenExpired',
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      await waitFor(() => {
        expect(screen.getByText(/sign-in needed/i)).toBeInTheDocument()
        expect(screen.getByText(/redirecting to login in 5 seconds/i)).toBeInTheDocument()
      })
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // Logout handler (expired modal)
  // ─────────────────────────────────────────────────────────────────────

  describe('logout handler', () => {
    it('should call signOut with preserved login callbackUrl when Sign In Again is clicked', async () => {
      jest.useRealTimers()
      window.history.pushState({}, '', '/chat/thread-123')

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          error: 'RefreshTokenExpired',
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      await waitFor(() => {
        expect(screen.getByText(/sign-in needed/i)).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('button', { name: /sign in again/i }))

      await waitFor(() => {
        expect(mockSignOut).toHaveBeenCalledWith({
          callbackUrl: '/login?session_expired=true&callbackUrl=%2Fchat%2Fthread-123',
        })
      })
    })

    it('should keep token-expiry-handling flag set when Sign In Again is clicked', async () => {
      jest.useRealTimers()
      // Pre-populate the flag (as set when entering the error/expired state)
      sessionStorageData['token-expiry-handling'] = 'true'

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          error: 'RefreshTokenExpired',
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      await waitFor(() => {
        expect(screen.getByText(/sign-in needed/i)).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('button', { name: /sign in again/i }))

      await waitFor(() => {
        expect(mockSessionStorage.setItem).toHaveBeenCalledWith('token-expiry-handling', 'true')
      })
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // Auto-logout countdown
  // ─────────────────────────────────────────────────────────────────────

  describe('auto-logout countdown', () => {
    it('should auto-redirect after 5 seconds when RefreshTokenExpired', async () => {
      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          error: 'RefreshTokenExpired',
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      // Mount triggers checkTokenExpiry which sets a 5s setTimeout
      await act(async () => { jest.advanceTimersByTime(0) })

      // Advance 5 seconds — auto-logout fires
      await act(async () => { jest.advanceTimersByTime(5000) })

      expect(mockSignOut).toHaveBeenCalledWith({
        callbackUrl: '/login?session_expired=true&callbackUrl=%2F',
      })
    })

    it('should auto-redirect after 5 seconds when token has actually expired', async () => {
      const pastExpiry = Math.floor(Date.now() / 1000) - 10 // expired 10s ago

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          expiresAt: pastExpiry,
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      render(<TokenExpiryGuard />)

      await act(async () => { jest.advanceTimersByTime(0) })
      await act(async () => { jest.advanceTimersByTime(5000) })

      expect(mockSignOut).toHaveBeenCalledWith({
        callbackUrl: '/login?session_expired=true&callbackUrl=%2F',
      })
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // Warning hidden when token is refreshed (else-if branch)
  // ─────────────────────────────────────────────────────────────────────

  describe('warning cleared after token refresh', () => {
    it('should hide warning and remove flag when token is refreshed (outside warning window)', async () => {
      jest.useRealTimers()
      const soonExpiry = Math.floor(Date.now() / 1000) + 240

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          expiresAt: soonExpiry,
          hasRefreshToken: true,
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      const { rerender } = render(<TokenExpiryGuard />)

      // Wait for warning to appear
      await waitFor(() => {
        expect(screen.getByText(/session expiring soon/i)).toBeInTheDocument()
      })

      // Simulate token refresh: new expiresAt far in the future
      const refreshedExpiry = Math.floor(Date.now() / 1000) + 3600 // 1 hour

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          expiresAt: refreshedExpiry,
          hasRefreshToken: true,
        } as unknown,
        status: 'authenticated',
        update: mockUpdateSession,
      })

      rerender(<TokenExpiryGuard />)

      // Warning should disappear because we're now outside the warning window
      await waitFor(() => {
        expect(screen.queryByText(/session expiring soon/i)).not.toBeInTheDocument()
      })
    })
  })
})
