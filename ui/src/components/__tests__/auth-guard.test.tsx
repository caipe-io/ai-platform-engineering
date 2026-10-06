/**
 * Unit tests for AuthGuard component
 * Tests route protection, token validation, and redirect behavior
 */

import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { signOut, useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { AuthGuard } from '../auth-guard'

// Mock Next Auth
jest.mock('next-auth/react', () => ({
  useSession: jest.fn(),
  signOut: jest.fn(() => Promise.resolve()),
}))

// Mock Next Router
let mockPathname = '/chat/test-uuid'
jest.mock('next/navigation', () => ({
  useRouter: jest.fn(),
  usePathname: () => mockPathname,
}))

// Mock config
jest.mock('@/lib/config', () => ({
  getConfig: jest.fn((key: string) => {
    if (key === 'ssoEnabled') return true
    return undefined
  }),
}))

// Mock auth-utils
jest.mock('@/lib/auth-utils', () => ({
  isTokenExpired: jest.fn((expiresAt: number, buffer: number) => {
    const now = Math.floor(Date.now() / 1000)
    return now >= (expiresAt - buffer)
  }),
}))

// Mock LoadingScreen
jest.mock('@/components/loading-screen', () => ({
  LoadingScreen: ({ message }: { message: string }) => <div data-testid="loading-screen">{message}</div>,
}))

describe('AuthGuard', () => {
  const mockPush = jest.fn()
  const mockSignOut = signOut as jest.MockedFunction<typeof signOut>
  const mockUseSession = useSession as jest.MockedFunction<typeof useSession>
  const mockUseRouter = useRouter as jest.MockedFunction<typeof useRouter>

  beforeEach(() => {
    jest.clearAllMocks()
    mockPathname = '/chat/test-uuid'

    mockUseRouter.mockReturnValue({
      push: mockPush,
    } as unknown)
  })

  describe('SSO Disabled', () => {
    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getConfig } = require('@/lib/config')
      getConfig.mockImplementation((key: string) => {
        if (key === 'ssoEnabled') return false
        return undefined
      })
    })

    it('should render children directly when SSO is disabled', async () => {
      mockUseSession.mockReturnValue({
        data: null,
        status: 'unauthenticated',
      } as unknown)

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(screen.getByTestId('protected-content')).toBeInTheDocument()
      })

      expect(mockPush).not.toHaveBeenCalled()
    })
  })

  describe('SSO Enabled', () => {
    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getConfig } = require('@/lib/config')
      getConfig.mockImplementation((key: string) => {
        if (key === 'ssoEnabled') return true
        return undefined
      })
    })

    it('should show loading screen while checking SSO config', () => {
      mockUseSession.mockReturnValue({
        data: null,
        status: 'loading',
      } as unknown)

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      // Should render nothing initially (SSO config check)
      expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument()
    })

    it('should show loading screen while session is loading', async () => {
      mockUseSession.mockReturnValue({
        data: null,
        status: 'loading',
      } as unknown)

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(screen.getByTestId('loading-screen')).toBeInTheDocument()
      })

      expect(screen.getByText(/checking authentication/i)).toBeInTheDocument()
    })

    it('should redirect to login with callbackUrl when unauthenticated', async () => {
      mockUseSession.mockReturnValue({
        data: null,
        status: 'unauthenticated',
      } as unknown)

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/login?callbackUrl=%2Fchat%2Ftest-uuid')
      })

      expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument()
    })

    it('should redirect to /login without callbackUrl when on root path', async () => {
      mockPathname = '/'
      mockUseSession.mockReturnValue({
        data: null,
        status: 'unauthenticated',
      } as unknown)

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/login')
      })
    })

    it('should redirect to unauthorized when user lacks required group', async () => {
      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          isAuthorized: false,
        } as unknown,
        status: 'authenticated',
      })

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/unauthorized')
      })
    })

    it('should redirect to login with callbackUrl when refresh token expired', async () => {
      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          isAuthorized: true,
          error: 'RefreshTokenExpired',
        } as unknown,
        status: 'authenticated',
      })

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/login?session_expired=true&callbackUrl=%2Fchat%2Ftest-uuid')
      })
    })

    it('should redirect to login with callbackUrl when refresh token error occurs', async () => {
      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          isAuthorized: true,
          error: 'RefreshTokenError',
        } as unknown,
        status: 'authenticated',
      })

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/login?session_expired=true&callbackUrl=%2Fchat%2Ftest-uuid')
      })
    })

    it('should redirect to login with callbackUrl when token is expired', async () => {
      const expiredTime = Math.floor(Date.now() / 1000) - 100 // Expired 100 seconds ago

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          isAuthorized: true,
          expiresAt: expiredTime,
        } as unknown,
        status: 'authenticated',
      })

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/login?session_expired=true&callbackUrl=%2Fchat%2Ftest-uuid')
      })
    })

    it('should render children when authenticated and authorized', async () => {
      const futureExpiry = Math.floor(Date.now() / 1000) + 600 // 10 minutes from now

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          isAuthorized: true,
          expiresAt: futureExpiry,
        } as unknown,
        status: 'authenticated',
      })

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(screen.getByTestId('protected-content')).toBeInTheDocument()
      })

      expect(mockPush).not.toHaveBeenCalled()
    })

    it('should show loading then render content for valid session', async () => {
      const futureExpiry = Math.floor(Date.now() / 1000) + 600

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          isAuthorized: true,
          expiresAt: futureExpiry,
        } as unknown,
        status: 'authenticated',
      })

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      // Should eventually show content after auth check
      await waitFor(() => {
        expect(screen.getByTestId('protected-content')).toBeInTheDocument()
      })

      expect(mockPush).not.toHaveBeenCalled()
    })

    it('should handle token close to expiry (within 60s buffer)', async () => {
      const soonExpiry = Math.floor(Date.now() / 1000) + 30 // 30 seconds from now (within 60s buffer)

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          isAuthorized: true,
          expiresAt: soonExpiry,
        } as unknown,
        status: 'authenticated',
      })

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/login?session_expired=true&callbackUrl=%2Fchat%2Ftest-uuid')
      })
    })

    it('should not redirect when token is valid and beyond buffer', async () => {
      const validExpiry = Math.floor(Date.now() / 1000) + 300 // 5 minutes from now (beyond 60s buffer)

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          isAuthorized: true,
          expiresAt: validExpiry,
        } as unknown,
        status: 'authenticated',
      })

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(screen.getByTestId('protected-content')).toBeInTheDocument()
      })

      expect(mockPush).not.toHaveBeenCalled()
    })
  })

  describe('Edge Cases', () => {
    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getConfig } = require('@/lib/config')
      getConfig.mockImplementation((key: string) => {
        if (key === 'ssoEnabled') return true
        return undefined
      })
    })

    it('should handle session without expiresAt', async () => {
      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          isAuthorized: true,
          // No expiresAt field
        } as unknown,
        status: 'authenticated',
      })

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(screen.getByTestId('protected-content')).toBeInTheDocument()
      })
    })

    it('should handle explicitly false isAuthorized flag', async () => {
      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          isAuthorized: false, // Explicitly set to false
        } as unknown,
        status: 'authenticated',
      })

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/unauthorized')
      })
    })

    it('should prioritize refresh token errors over token expiry', async () => {
      const expiredTime = Math.floor(Date.now() / 1000) - 100

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          isAuthorized: true,
          error: 'RefreshTokenExpired',
          expiresAt: expiredTime,
        } as unknown,
        status: 'authenticated',
      })

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/login?session_expired=true&callbackUrl=%2Fchat%2Ftest-uuid')
      })

      // Should only redirect once (for refresh error, not for expired token)
      expect(mockPush).toHaveBeenCalledTimes(1)
    })
  })

  describe('TokenExpiryGuard coordination', () => {
    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getConfig } = require('@/lib/config')
      getConfig.mockImplementation((key: string) => {
        if (key === 'ssoEnabled') return true
        return undefined
      })
    })

    it('should skip redirect and render children when token-expiry-handling flag is set', async () => {
      // Simulate TokenExpiryGuard handling expiry
      Object.defineProperty(window, 'sessionStorage', {
        value: {
          getItem: (key: string) => key === 'token-expiry-handling' ? 'true' : null,
          setItem: jest.fn(),
          removeItem: jest.fn(),
          clear: jest.fn(),
        },
        writable: true,
      })

      const soonExpiry = Math.floor(Date.now() / 1000) + 30 // within 60s buffer

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          isAuthorized: true,
          expiresAt: soonExpiry,
        } as unknown,
        status: 'authenticated',
      })

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      // Should render children (not redirect) because TokenExpiryGuard is handling it
      await waitFor(() => {
        expect(screen.getByTestId('protected-content')).toBeInTheDocument()
      })

      // Should NOT redirect to login (with or without callbackUrl)
      expect(mockPush).not.toHaveBeenCalled()
    })

    it('should handle RefreshTokenMissing error gracefully without crashing', async () => {
      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          isAuthorized: true,
          error: 'RefreshTokenMissing',
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        } as unknown,
        status: 'authenticated',
      })

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      // RefreshTokenMissing is not RefreshTokenExpired/Error, so it should render
      await waitFor(() => {
        expect(screen.getByTestId('protected-content')).toBeInTheDocument()
      })
    })

    it('should handle transition from loading to authenticated without extra redirect', async () => {
      // Start as loading
      mockUseSession.mockReturnValue({
        data: null,
        status: 'loading',
      } as unknown)

      const { rerender } = render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      // Should show loading
      expect(screen.getByTestId('loading-screen')).toBeInTheDocument()

      // Transition to authenticated
      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          isAuthorized: true,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        } as unknown,
        status: 'authenticated',
      })

      rerender(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      // Should render content without any redirect
      await waitFor(() => {
        expect(screen.getByTestId('protected-content')).toBeInTheDocument()
      })

      expect(mockPush).not.toHaveBeenCalled()
    })
  })

  // ===========================================================================
  // callbackUrl preservation — full flow edge cases
  // ===========================================================================

  describe('callbackUrl preservation', () => {
    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getConfig } = require('@/lib/config')
      getConfig.mockImplementation((key: string) => {
        if (key === 'ssoEnabled') return true
        return undefined
      })

      // Restore sessionStorage to a clean state — earlier tests
      // (TokenExpiryGuard coordination) replace it with a stub that
      // returns 'true' for 'token-expiry-handling', which would cause
      // AuthGuard to skip all redirects.
      Object.defineProperty(window, 'sessionStorage', {
        value: {
          getItem: jest.fn(() => null),
          setItem: jest.fn(),
          removeItem: jest.fn(),
          clear: jest.fn(),
        },
        writable: true,
      })
    })

    it('should NOT include callbackUrl when already on /login', async () => {
      mockPathname = '/login'

      mockUseSession.mockReturnValue({
        data: null,
        status: 'unauthenticated',
      } as unknown)

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/login')
      })
    })

    it('should encode deeply nested paths in callbackUrl', async () => {
      mockPathname = '/chat/abc-123/details'

      mockUseSession.mockReturnValue({
        data: null,
        status: 'unauthenticated',
      } as unknown)

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith(
          '/login?callbackUrl=%2Fchat%2Fabc-123%2Fdetails'
        )
      })
    })

    it('should include callbackUrl on /knowledge-bases path', async () => {
      mockPathname = '/knowledge-bases'

      mockUseSession.mockReturnValue({
        data: null,
        status: 'unauthenticated',
      } as unknown)

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith(
          '/login?callbackUrl=%2Fknowledge-bases'
        )
      })
    })

    it('should include callbackUrl on /admin path', async () => {
      mockPathname = '/admin'

      mockUseSession.mockReturnValue({
        data: null,
        status: 'unauthenticated',
      } as unknown)

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith(
          '/login?callbackUrl=%2Fadmin'
        )
      })
    })

    it('should include callbackUrl with session_expired for expired token on deep path', async () => {
      mockPathname = '/chat/b76e290b-d90d-4dd6-8db7-fbda49f3fa6d'
      const expiredTime = Math.floor(Date.now() / 1000) - 100

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          isAuthorized: true,
          expiresAt: expiredTime,
        } as unknown,
        status: 'authenticated',
      })

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith(
          '/login?session_expired=true&callbackUrl=%2Fchat%2Fb76e290b-d90d-4dd6-8db7-fbda49f3fa6d'
        )
      })
    })

    it('should include callbackUrl with session_expired for RefreshTokenExpired on deep path', async () => {
      mockPathname = '/use-cases'

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          isAuthorized: true,
          error: 'RefreshTokenExpired',
        } as unknown,
        status: 'authenticated',
      })

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith(
          '/login?session_expired=true&callbackUrl=%2Fuse-cases'
        )
      })
    })

    it('should only initiate one sign-out while the failed session rerenders', async () => {
      const failedSession = {
        user: { name: 'Test User', email: 'test@example.com' },
        isAuthorized: true,
        error: 'RefreshTokenExpired',
      }
      mockUseSession.mockReturnValue({
        data: failedSession as unknown,
        status: 'authenticated',
      })

      const { rerender } = render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      mockUseSession.mockReturnValue({
        data: { ...failedSession } as unknown,
        status: 'authenticated',
      })
      rerender(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => expect(mockSignOut).toHaveBeenCalledTimes(1))
    })

    it('should NOT include callbackUrl for RefreshTokenExpired when on root /', async () => {
      mockPathname = '/'

      mockUseSession.mockReturnValue({
        data: {
          user: { name: 'Test User', email: 'test@example.com' },
          isAuthorized: true,
          error: 'RefreshTokenExpired',
        } as unknown,
        status: 'authenticated',
      })

      render(
        <AuthGuard>
          <div data-testid="protected-content">Protected Content</div>
        </AuthGuard>
      )

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/login?session_expired=true')
      })
    })
  })
})
