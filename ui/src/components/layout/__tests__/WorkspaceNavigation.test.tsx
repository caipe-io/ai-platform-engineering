import React from 'react'
import {
  act,
  fireEvent,
  render,
  screen,
} from '@testing-library/react'
import { Shield } from 'lucide-react'

import { CollapsedNavigationFlyout } from '../WorkspaceNavigation'

function CategoryDisclosure(): React.ReactElement {
  const [expanded,setExpanded] = React.useState(true)
  return (
    <div>
      <button
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        Resources
      </button>
      {expanded ? <div>Resource destinations</div> : null}
    </div>
  )
}

describe('CollapsedNavigationFlyout', () => {
  it('stays open when a focused category collapse changes flyout geometry', () => {
    jest.useFakeTimers()
    try {
      render(
        <CollapsedNavigationFlyout active icon={Shield} label="Admin">
          {() => <CategoryDisclosure />}
        </CollapsedNavigationFlyout>,
      )

      const trigger = screen.getByRole('button', { name: 'Admin' })
      fireEvent.mouseEnter(trigger)
      const resources = screen.getByRole('button', { name: 'Resources' })
      const flyout = resources.closest('[data-popover-content]')

      resources.focus()
      fireEvent.click(resources)
      fireEvent.mouseLeave(flyout!)
      act(() => jest.advanceTimersByTime(100))

      expect(trigger).toHaveAttribute('aria-expanded', 'true')
      expect(resources).toHaveAttribute('aria-expanded', 'false')
      expect(resources).toBeVisible()
    } finally {
      jest.runOnlyPendingTimers()
      jest.useRealTimers()
    }
  })
})
