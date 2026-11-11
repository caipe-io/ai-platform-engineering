/**
 * Unit tests for Login page
 *
 * Tests cover:
 * - Redirect loop detection and circuit breaker
 * - Authenticated user redirect to app (happy path)
 * - No redirect when session_expired param is present
 * - No redirect when session_reset param is present
 * - Session expired message display
 * - Loop broken message display
 * - Error message display
 * - Sign-in button clears loop counter
 */

import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { useSession, signIn } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'

// Must import the component AFTER mocks are set up
let LoginPage: React.ComponentType

// Mock Next Auth
jest.mock('next-auth/react', () => ({
  useSession: jest.fn(),
  signIn: jest.fn(),
}))

// Mock Next Router
const mockPush = jest.fn()
const mockSearchParamsGet = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: jest.fn(),
  useSearchParams: jest.fn(),
}))

// Mock config
jest.mock('@/lib/config', () => ({
  config: {
    appName: 'Test App',
    tagline: 'Test tagline',
    description: 'Test description',
    logoUrl: '/logo.png',
    logoStyle: 'default',
    envBadge: '',
    showPoweredBy: false,
  },
  getLogoFilterClass: jest.fn(() => ''),
}))

// Mock LoadingScreen
jest.mock('@/components/loading-screen', () => ({
  LoadingScreen: ({ message }: { message: string }) => (
    <div data-testid="loading-screen">{message}</div>
  ),
}))

// Mock IntegrationOrbit
jest.mock('@/components/gallery/IntegrationOrbit', () => ({
  IntegrationOrbit: () => <div data-testid="integration-orbit" />,
}))

// Mock framer-motion
jest.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: unknown) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: unknown) => <>{children}</>,
}))

describe('Login Page', () => {
  const mockUseSession = useSession as jest.MockedFunction<typeof useSession>
  const mockUseRouter = useRouter as jest.MockedFunction<typeof useRouter>
  const mockUseSearchParams = useSearchParams as jest.MockedFunction<typeof useSearchParams>
  const mockSignIn = signIn as jest.MockedFunction<typeof signIn>

  // Mock sessionStorage
  let sessionStorageData: Record<string, string> = {}
  const mockSessionStorage = {
    getItem: jest.fn((key: string) => sessionStorageData[key] ?? null),
    setItem: jest.fn((key: string, value: string) => { sessionStorageData[key] = value }),
    removeItem: jest.fn((key: string) => { delete sessionStorageData[key] }),
    clear: jest.fn(() => { sessionStorageData = {} }),
  }

  // Mock localStorage
  const mockLocalStorage = {
    getItem: jest.fn(() => null),
    setItem: jest.fn(),
    removeItem: jest.fn(),
    clear: jest.fn(),
  }

  beforeAll(async () => {
    // Dynamic import after mocks are ready
    const mod = await import('../page')
    LoginPage = mod.default
  })

  beforeEach(() => {
    jest.clearAllMocks()
    sessionStorageData = {}
    Object.defineProperty(window, 'sessionStorage', { value: mockSessionStorage, writable: true })
    Object.defineProperty(window, 'localStorage', { value: mockLocalStorage, writable: true })

    // Mock document.cookie
    Object.defineProperty(document, 'cookie', { value: '', writable: true, configurable: true })

    mockUseRouter.mockReturnValue({ push: mockPush } as unknown)

    // Default searchParams: no special params
    mockSearchParamsGet.mockReturnValue(null)
    mockUseSearchParams.mockReturnValue({
      get: mockSearchParamsGet,
    } as unknown)

    mockSignIn.mockResolvedValue(undefined as unknown)
  })

  // ─────────────────────────────────────────────────────────────────────
  // Basic rendering
  // ─────────────────────────────────────────────────────────────────────

  it('should render login button when unauthenticated', () => {
    mockUseSession.mockReturnValue({ data: null, status: 'unauthenticated' } as unknown)

    render(<LoginPage />)

    expect(screen.getByText(/sign in with sso/i)).toBeInTheDocument()
  })

  it('should not show environment badge when envBadge is empty', () => {
    mockUseSession.mockReturnValue({ data: null, status: 'unauthenticated' } as unknown)

    render(<LoginPage />)

    expect(screen.queryByText('Preview')).not.toBeInTheDocument()
    expect(screen.queryByText('Dev')).not.toBeInTheDocument()
    expect(screen.queryByText('Prod')).not.toBeInTheDocument()
  })

  it('should show loading screen while session is loading', () => {
    mockUseSession.mockReturnValue({ data: null, status: 'loading' } as unknown)

    render(<LoginPage />)

    expect(screen.getByTestId('loading-screen')).toBeInTheDocument()
  })

  // ─────────────────────────────────────────────────────────────────────
  // Authenticated user redirect
  // ─────────────────────────────────────────────────────────────────────

  it('should redirect authenticated user to callbackUrl', async () => {
    mockUseSession.mockReturnValue({
      data: { user: { name: 'Test' } },
      status: 'authenticated',
    } as unknown)

    render(<LoginPage />)

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/')
    })
  })

  it('should redirect authenticated user out of stale session_expired login URL', async () => {
    mockSearchParamsGet.mockImplementation((key: string) => {
      if (key === 'session_expired') return 'true'
      if (key === 'callbackUrl') return '/admin'
      return null
    })

    mockUseSession.mockReturnValue({
      data: { user: { name: 'Test' } },
      status: 'authenticated',
    } as unknown)

    render(<LoginPage />)

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/admin')
    })
  })

  it('should NOT redirect authenticated user when session_reset param is present', async () => {
    mockSearchParamsGet.mockImplementation((key: string) => {
      if (key === 'session_reset') return 'auto'
      return null
    })

    mockUseSession.mockReturnValue({
      data: { user: { name: 'Test' } },
      status: 'authenticated',
    } as unknown)

    render(<LoginPage />)

    await waitFor(() => {
      expect(screen.getByText(/sign in with sso/i)).toBeInTheDocument()
    })

    expect(mockPush).not.toHaveBeenCalled()
  })

  // ─────────────────────────────────────────────────────────────────────
  // Redirect loop detection
  // ─────────────────────────────────────────────────────────────────────

  it('should detect redirect loop and show reset message after 3 rapid visits', async () => {
    mockUseSession.mockReturnValue({
      data: { user: { name: 'Test' } },
      status: 'authenticated',
    } as unknown)

    // Simulate 2 prior visits within the time window
    const now = Date.now()
    sessionStorageData['login-redirect-count'] = '2'
    sessionStorageData['login-redirect-ts'] = String(now)

    render(<LoginPage />)

    // Should show loop-broken message (3rd visit = threshold hit)
    await waitFor(() => {
      expect(screen.getByText(/a sign-in loop/i)).toBeInTheDocument()
    })

    // Should NOT redirect (loop is broken)
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('should reset loop counter when visits are outside the time window', async () => {
    mockUseSession.mockReturnValue({ data: null, status: 'unauthenticated' } as unknown)

    // Simulate 2 prior visits but outside the 10s window (old timestamp)
    sessionStorageData['login-redirect-count'] = '2'
    sessionStorageData['login-redirect-ts'] = String(Date.now() - 20_000) // 20 seconds ago

    render(<LoginPage />)

    // Should NOT show loop message (counter was reset due to old timestamp)
    await waitFor(() => {
      expect(screen.queryByText(/a sign-in loop/i)).not.toBeInTheDocument()
    })

    // Counter should have been reset to 1
    expect(mockSessionStorage.setItem).toHaveBeenCalledWith('login-redirect-count', '1')
  })

  it('should clear cookies and storage when loop is detected', async () => {
    mockUseSession.mockReturnValue({
      data: { user: { name: 'Test' } },
      status: 'authenticated',
    } as unknown)

    // At threshold
    sessionStorageData['login-redirect-count'] = '2'
    sessionStorageData['login-redirect-ts'] = String(Date.now())

    render(<LoginPage />)

    await waitFor(() => {
      expect(screen.getByText(/a sign-in loop/i)).toBeInTheDocument()
    })

    // Should have cleared the loop counter keys
    expect(mockSessionStorage.removeItem).toHaveBeenCalledWith('login-redirect-count')
    expect(mockSessionStorage.removeItem).toHaveBeenCalledWith('login-redirect-ts')
    expect(mockSessionStorage.removeItem).toHaveBeenCalledWith('token-expiry-handling')
  })

  // ─────────────────────────────────────────────────────────────────────
  // Messages display
  // ─────────────────────────────────────────────────────────────────────

  it('should show session expired message when session_expired=true', async () => {
    mockSearchParamsGet.mockImplementation((key: string) => {
      if (key === 'session_expired') return 'true'
      return null
    })

    mockUseSession.mockReturnValue({ data: null, status: 'unauthenticated' } as unknown)

    render(<LoginPage />)

    await waitFor(() => {
      expect(screen.getByText(/session expired/i)).toBeInTheDocument()
      expect(screen.getByText(/Please sign in again to continue/i)).toBeInTheDocument()
    })
  })

  it('should show error message for OAuth errors', async () => {
    mockSearchParamsGet.mockImplementation((key: string) => {
      if (key === 'error') return 'OAuthCallback'
      return null
    })

    mockUseSession.mockReturnValue({ data: null, status: 'unauthenticated' } as unknown)

    render(<LoginPage />)

    await waitFor(() => {
      expect(screen.getByText(/Sign-in failed/i)).toBeInTheDocument()
    })
  })

  it('should prioritize loop-broken message over session-expired message', async () => {
    mockSearchParamsGet.mockImplementation((key: string) => {
      if (key === 'session_expired') return 'true'
      return null
    })

    mockUseSession.mockReturnValue({
      data: { user: { name: 'Test' } },
      status: 'authenticated',
    } as unknown)

    // Trigger loop detection
    sessionStorageData['login-redirect-count'] = '2'
    sessionStorageData['login-redirect-ts'] = String(Date.now())

    render(<LoginPage />)

    await waitFor(() => {
      // Loop message should show
      expect(screen.getByText(/a sign-in loop/i)).toBeInTheDocument()
      // Session expired message should NOT show (loop message takes priority)
      expect(screen.queryByText(/^Session expired$/i)).not.toBeInTheDocument()
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // Sign-in button
  // ─────────────────────────────────────────────────────────────────────

  it('should clear loop counter and token-expiry flag on sign-in click', async () => {
    mockUseSession.mockReturnValue({ data: null, status: 'unauthenticated' } as unknown)

    // Set some stale data
    sessionStorageData['login-redirect-count'] = '1'
    sessionStorageData['login-redirect-ts'] = String(Date.now())
    sessionStorageData['token-expiry-handling'] = 'true'

    render(<LoginPage />)

    fireEvent.click(screen.getByText(/sign in with sso/i))

    // Should clear loop counters
    expect(mockSessionStorage.removeItem).toHaveBeenCalledWith('login-redirect-count')
    expect(mockSessionStorage.removeItem).toHaveBeenCalledWith('login-redirect-ts')
    expect(mockSessionStorage.removeItem).toHaveBeenCalledWith('token-expiry-handling')

    // Should call signIn
    await waitFor(() => {
      expect(mockSignIn).toHaveBeenCalledWith('oidc', { callbackUrl: '/' })
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // callbackUrl flow — the full redirect-back-after-login journey
  // ─────────────────────────────────────────────────────────────────────

  describe('callbackUrl redirect flow', () => {
    it.each([null, 'session_expired', 'session_reset', 'loop'])('does not restore an abandoned destination for a new login (%s)', async recovery => {
      sessionStorageData['login-return-to'] = JSON.stringify({ path: '/chat/abandoned', savedAt: Date.now() });
      mockSearchParamsGet.mockImplementation((key: string) => key === recovery ? 'true' : null);
      if (recovery === 'loop') {
        sessionStorageData['login-redirect-count'] = '2';
        sessionStorageData['login-redirect-ts'] = String(Date.now());
      }
      mockUseSession.mockReturnValue({ data: null, status: 'unauthenticated' } as unknown);
      render(<LoginPage />);
      fireEvent.click(screen.getByText(/sign in with sso/i));
      await waitFor(() => expect(mockSignIn).toHaveBeenCalledWith('oidc', { callbackUrl: '/' }));
    });

    it.each(['unauthenticated', 'authenticated'])('normalizes the absolute OAuth retry destination when %s', async status => {
      mockSearchParamsGet.mockImplementation((key: string) => {
        if (key === 'callbackUrl') return `${window.location.origin}/chat/example?tab=activity`;
        if (key === 'error') return 'OAuthCallback';
        return null;
      });
      mockUseSession.mockReturnValue({ data: status === 'authenticated' ? { user: { name: 'Example' } } : null, status } as unknown);
      render(<LoginPage />);
      if (status === 'unauthenticated') {
        fireEvent.click(screen.getByText(/sign in with sso/i));
        await waitFor(() => expect(mockSignIn).toHaveBeenCalledWith('oidc', { callbackUrl: '/chat/example?tab=activity' }));
      } else {
        await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/chat/example?tab=activity'));
      }
    });

    it('restores the attempted destination when an error page drops callbackUrl', async () => {
      mockSearchParamsGet.mockImplementation((key: string) => key === 'callbackUrl' ? '/apps/example?tab=activity' : null);
      mockUseSession.mockReturnValue({ data: null, status: 'unauthenticated' } as unknown);
      const first = render(<LoginPage />);
      fireEvent.click(screen.getByText(/sign in with sso/i));
      await waitFor(() => expect(mockSignIn).toHaveBeenCalledWith('oidc', { callbackUrl: '/apps/example?tab=activity' }));
      first.unmount();
      mockSignIn.mockClear();
      mockSearchParamsGet.mockImplementation((key: string) => key === 'error' ? 'Configuration' : null);
      render(<LoginPage />);
      fireEvent.click(screen.getByText(/sign in with sso/i));
      await waitFor(() => expect(mockSignIn).toHaveBeenCalledWith('oidc', { callbackUrl: '/apps/example?tab=activity' }));
    });

    it('should redirect authenticated user to callbackUrl from search params', async () => {
      mockSearchParamsGet.mockImplementation((key: string) => {
        if (key === 'callbackUrl') return '/chat/b76e290b-d90d-4dd6-8db7-fbda49f3fa6d'
        return null
      })

      mockUseSession.mockReturnValue({
        data: { user: { name: 'Test' } },
        status: 'authenticated',
      } as unknown)

      render(<LoginPage />)

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/chat/b76e290b-d90d-4dd6-8db7-fbda49f3fa6d')
      })
    })

    it('should pass callbackUrl to signIn when clicking sign-in button', async () => {
      mockSearchParamsGet.mockImplementation((key: string) => {
        if (key === 'callbackUrl') return '/chat/some-uuid'
        return null
      })

      mockUseSession.mockReturnValue({ data: null, status: 'unauthenticated' } as unknown)

      render(<LoginPage />)

      fireEvent.click(screen.getByText(/sign in with sso/i))

      await waitFor(() => {
        expect(mockSignIn).toHaveBeenCalledWith('oidc', { callbackUrl: '/chat/some-uuid' })
      })
    })

    it('should not pass nested login callbackUrl back into signIn', async () => {
      mockSearchParamsGet.mockImplementation((key: string) => {
        if (key === 'callbackUrl') return '/login?session_expired=true&callbackUrl=%2Fadmin'
        return null
      })

      mockUseSession.mockReturnValue({ data: null, status: 'unauthenticated' } as unknown)

      render(<LoginPage />)

      fireEvent.click(screen.getByText(/sign in with sso/i))

      await waitFor(() => {
        expect(mockSignIn).toHaveBeenCalledWith('oidc', { callbackUrl: '/' })
      })
    })

    it('should use "/" as default callbackUrl when none provided', async () => {
      mockSearchParamsGet.mockReturnValue(null)

      mockUseSession.mockReturnValue({
        data: { user: { name: 'Test' } },
        status: 'authenticated',
      } as unknown)

      render(<LoginPage />)

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/')
      })
    })

    it('should redirect to callbackUrl for /knowledge-bases path', async () => {
      mockSearchParamsGet.mockImplementation((key: string) => {
        if (key === 'callbackUrl') return '/knowledge-bases'
        return null
      })

      mockUseSession.mockReturnValue({
        data: { user: { name: 'Test' } },
        status: 'authenticated',
      } as unknown)

      render(<LoginPage />)

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/knowledge-bases')
      })
    })

    it('should redirect to callbackUrl for /admin path', async () => {
      mockSearchParamsGet.mockImplementation((key: string) => {
        if (key === 'callbackUrl') return '/admin'
        return null
      })

      mockUseSession.mockReturnValue({
        data: { user: { name: 'Test' } },
        status: 'authenticated',
      } as unknown)

      render(<LoginPage />)

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/admin')
      })
    })

    it('should redirect authenticated users to callbackUrl when session_expired is stale', async () => {
      mockSearchParamsGet.mockImplementation((key: string) => {
        if (key === 'callbackUrl') return '/chat/some-uuid'
        if (key === 'session_expired') return 'true'
        return null
      })

      mockUseSession.mockReturnValue({
        data: { user: { name: 'Test' } },
        status: 'authenticated',
      } as unknown)

      render(<LoginPage />)

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/chat/some-uuid')
      })
    })

    it('should pass callbackUrl to signIn even when session_expired was present', async () => {
      mockSearchParamsGet.mockImplementation((key: string) => {
        if (key === 'callbackUrl') return '/chat/my-conversation'
        if (key === 'session_expired') return 'true'
        return null
      })

      mockUseSession.mockReturnValue({ data: null, status: 'unauthenticated' } as unknown)

      render(<LoginPage />)

      fireEvent.click(screen.getByText(/sign in with sso/i))

      await waitFor(() => {
        expect(mockSignIn).toHaveBeenCalledWith('oidc', {
          callbackUrl: '/chat/my-conversation',
        })
      })
    })

    it('should show session expired message while preserving callbackUrl for sign-in', async () => {
      mockSearchParamsGet.mockImplementation((key: string) => {
        if (key === 'callbackUrl') return '/chat/expired-session-uuid'
        if (key === 'session_expired') return 'true'
        return null
      })

      mockUseSession.mockReturnValue({ data: null, status: 'unauthenticated' } as unknown)

      render(<LoginPage />)

      // Session expired message should be visible
      expect(screen.getByText(/session expired/i)).toBeInTheDocument()
      expect(screen.getByText(/Please sign in again to continue/i)).toBeInTheDocument()

      // Sign in button should be present
      fireEvent.click(screen.getByText(/sign in with sso/i))

      // callbackUrl should be the original deep link, not "/"
      await waitFor(() => {
        expect(mockSignIn).toHaveBeenCalledWith('oidc', {
          callbackUrl: '/chat/expired-session-uuid',
        })
      })
    })
  })
})
