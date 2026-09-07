/**
 * Unit tests for the Home Page (app/(app)/page.tsx)
 *
 * The page always renders the customizable Home experience.
 *
 * Tests:
 * - AuthGuard: wraps page in AuthGuard
 * - Page structure: data-testid
 * - Calls home-widgets-store initialize() on mount
 * - Always renders the shared welcome banner
 * - Renders NewHomePage as the only Home experience
 */

import React from 'react'
import { render, screen } from '@testing-library/react'

jest.mock('@/components/auth-guard', () => ({
  AuthGuard: ({ children }: unknown) => <div data-testid="auth-guard">{children}</div>,
}))

jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, ...props }: unknown) => (
    <div data-testid={props['data-testid'] || 'scroll-area'} {...props}>{children}</div>
  ),
}))

jest.mock('@/components/home/NewHomePage', () => ({
  NewHomePage: () => <div data-testid="new-home-page-stub" />,
}))

jest.mock('@/components/home/WelcomeBanner', () => ({
  WelcomeBanner: () => <div data-testid="welcome-banner" />,
}))

const mockInitialize = jest.fn()

jest.mock('@/store/home-widgets-store', () => ({
  useHomeWidgetsStore: (selector: (state: unknown) => unknown) =>
    selector({ initialize: mockInitialize }),
}))

import HomePage from '../page'

describe('HomePage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('wraps the page in AuthGuard', () => {
    render(<HomePage />)
    expect(screen.getByTestId('auth-guard')).toBeInTheDocument()
  })

  it('renders with data-testid="home-page"', () => {
    render(<HomePage />)
    expect(screen.getByTestId('home-page')).toBeInTheDocument()
  })

  it('calls home-widgets-store initialize() on mount', () => {
    render(<HomePage />)
    expect(mockInitialize).toHaveBeenCalled()
  })

  it('renders the customizable Home experience', () => {
    render(<HomePage />)
    expect(screen.getByTestId('new-home-page-stub')).toBeInTheDocument()
    expect(screen.getByTestId('welcome-banner')).toBeInTheDocument()
  })

  it('reclaims inter-section space on short desktop viewports', () => {
    render(<HomePage />)
    expect(screen.getByTestId('welcome-banner').parentElement).toHaveClass(
      'space-y-3',
      '[@media(max-height:800px)]:space-y-1',
      '[@media(max-height:800px)]:pb-2'
    )
  })
})
