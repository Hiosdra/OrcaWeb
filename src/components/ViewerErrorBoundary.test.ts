import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../lib/log', () => ({ logError: vi.fn() }))

import { logError } from '../lib/log'
import { ViewerErrorBoundary } from './ViewerErrorBoundary'

// No jsdom/testing-library in this repo — these exercise the boundary's
// lifecycle methods and render() output directly (plain React-element
// objects, no DOM needed) rather than mounting it into a real tree.

describe('ViewerErrorBoundary', () => {
  it('renders its children when nothing has thrown', () => {
    const children = createElement('span', null, 'viewer')
    const boundary = new ViewerErrorBoundary({ message: 'fallback', children })
    expect(boundary.render()).toBe(children)
  })

  it('getDerivedStateFromError flips to the error state', () => {
    expect(ViewerErrorBoundary.getDerivedStateFromError()).toEqual({ hasError: true })
  })

  it('renders the fallback message instead of children once in the error state', () => {
    const children = createElement('span', null, 'viewer')
    const boundary = new ViewerErrorBoundary({ message: 'fallback text', children })
    boundary.state = { hasError: true }
    const output = boundary.render()
    expect(output).not.toBe(children)
    expect(JSON.stringify(output)).toContain('fallback text')
  })

  it('logs the caught error via componentDidCatch', () => {
    const boundary = new ViewerErrorBoundary({ message: 'x', children: null })
    const error = new Error('boom')
    boundary.componentDidCatch(error, { componentStack: 'at ModelViewer' })
    expect(logError).toHaveBeenCalledWith('Viewer crashed', error, 'at ModelViewer')
  })
})
