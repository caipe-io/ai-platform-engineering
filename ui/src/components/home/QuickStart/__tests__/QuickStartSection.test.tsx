/**
 * Unit tests for QuickStartSection
 *
 * Tests:
 * - Renders the section heading and all four tabs
 * - Build tab is active by default with its 5 cards
 * - Switching tabs shows the correct cards
 * - Each card links to its documented destination route
 * - Explore tab ships with only the chat card (Projects intentionally omitted)
 */

import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

jest.mock('next/link', () => {
  // eslint-disable-next-line react/display-name
  return React.forwardRef(({ children, href, className, ...props }: unknown, ref: unknown) => (
    <a ref={ref} href={href} className={className} data-testid={props['data-testid'] || `link-${href}`} {...props}>
      {children}
    </a>
  ))
})

jest.mock('lucide-react', () => {
  // eslint-disable-next-line react/display-name
  const stub = (name: string) => (props: unknown) => <svg data-testid={`icon-${name}`} {...props} />
  return new Proxy(
    {},
    { get: (_target, prop: string) => stub(prop) },
  )
})

import { QuickStartSection } from '../QuickStartSection'
import { QUICK_START_TABS } from '../quickStartCards'

describe('QuickStartSection', () => {
  it('renders the section heading', () => {
    render(<QuickStartSection />)
    expect(screen.getByText('Quick start')).toBeInTheDocument()
  })

  it('renders all four tabs', () => {
    render(<QuickStartSection />)
    for (const tab of QUICK_START_TABS) {
      expect(screen.getByTestId(`quick-start-tab-${tab.id}`)).toBeInTheDocument()
    }
  })

  it('shows the Build tab cards by default', () => {
    render(<QuickStartSection />)
    expect(screen.getByTestId('quick-start-card-build-agent')).toBeInTheDocument()
    expect(screen.getByTestId('quick-start-card-add-mcp-server')).toBeInTheDocument()
    expect(screen.getByTestId('quick-start-card-create-skills')).toBeInTheDocument()
    expect(screen.getByTestId('quick-start-card-add-knowledge-base')).toBeInTheDocument()
    expect(screen.getByTestId('quick-start-card-add-model')).toBeInTheDocument()
  })

  it('keeps the five default actions in one desktop frame', () => {
    render(<QuickStartSection />)
    expect(screen.getByTestId('quick-start-card-grid')).toHaveClass('xl:grid-cols-5')
  })

  it('uses a distinct icon accent for every Quick Start action', () => {
    const iconAccents = QUICK_START_TABS.flatMap((tab) =>
      tab.cards.map((card) => card.iconClassName),
    )

    expect(new Set(iconAccents).size).toBe(iconAccents.length)

    render(<QuickStartSection />)
    expect(screen.getByTestId('quick-start-icon-build-agent')).toHaveClass(
      'from-violet-500',
      'to-fuchsia-500',
    )
    expect(screen.getByTestId('quick-start-icon-create-skills')).toHaveClass(
      'from-amber-400',
      'to-orange-500',
    )
  })

  it('switches to the Automate tab and shows its cards', () => {
    render(<QuickStartSection />)
    fireEvent.mouseDown(screen.getByTestId('quick-start-tab-automate'), { button: 0 })
    expect(screen.getByTestId('quick-start-card-build-workflow')).toBeInTheDocument()
    expect(screen.getByTestId('quick-start-card-create-schedules')).toBeInTheDocument()
  })

  it('switches to the Connect tab and shows its cards', () => {
    render(<QuickStartSection />)
    fireEvent.mouseDown(screen.getByTestId('quick-start-tab-connect'), { button: 0 })
    expect(screen.getByTestId('quick-start-card-connect-apps')).toBeInTheDocument()
    expect(screen.getByTestId('quick-start-card-secrets')).toBeInTheDocument()
  })

  it('Explore tab ships with only the chat card', () => {
    render(<QuickStartSection />)
    fireEvent.mouseDown(screen.getByTestId('quick-start-tab-explore'), { button: 0 })
    expect(screen.getByTestId('quick-start-card-chat-assistants')).toBeInTheDocument()
    expect(screen.queryByTestId('quick-start-card-projects')).not.toBeInTheDocument()
  })

  it('each card CTA links to its documented destination route', () => {
    render(<QuickStartSection />)
    expect(screen.getByTestId('quick-start-cta-build-agent')).toHaveAttribute('href', '/dynamic-agents')
    expect(screen.getByTestId('quick-start-cta-add-mcp-server')).toHaveAttribute(
      'href',
      '/dynamic-agents?tab=mcp-servers',
    )
    expect(screen.getByTestId('quick-start-cta-create-skills')).toHaveAttribute('href', '/skills/workspace/new')
    expect(screen.getByTestId('quick-start-cta-add-knowledge-base')).toHaveAttribute(
      'href',
      '/knowledge-bases/ingest',
    )

    fireEvent.mouseDown(screen.getByTestId('quick-start-tab-automate'), { button: 0 })
    expect(screen.getByTestId('quick-start-cta-build-workflow')).toHaveAttribute('href', '/workflows')
    expect(screen.getByTestId('quick-start-cta-create-schedules')).toHaveAttribute('href', '/schedules')

    fireEvent.mouseDown(screen.getByTestId('quick-start-tab-connect'), { button: 0 })
    expect(screen.getByTestId('quick-start-cta-connect-apps')).toHaveAttribute('href', '/credentials/connections')
    expect(screen.getByTestId('quick-start-cta-secrets')).toHaveAttribute('href', '/credentials/secrets')

    fireEvent.mouseDown(screen.getByTestId('quick-start-tab-explore'), { button: 0 })
    expect(screen.getByTestId('quick-start-cta-chat-assistants')).toHaveAttribute('href', '/chat')
  })
})
