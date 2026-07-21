import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logError } from '../lib/log'

interface Props {
  children: ReactNode
  message: string
  /** Clears a previous crash when this value changes. Prefer it over a
   *  `key` on the boundary: `key` throws away the whole subtree, so the
   *  viewer below tears down and recreates its WebGL context every time the
   *  value changes — and the viewers already rebuild their own scene from
   *  their effect dependencies, making that a redundant second teardown (and
   *  a way to churn through the browser's active-context limit). */
  resetKey?: string
}

interface State {
  hasError: boolean
  resetKey?: string
}

/**
 * Defense in depth around the Three.js viewers: WebGL/Three.js can still
 * throw at runtime for reasons isWebGLAvailable() doesn't catch (context
 * loss, driver quirks, etc). Without a boundary here, that throw propagates
 * past App.tsx (which has none) and unmounts the whole app — upload queue,
 * settings, everything.
 */
export class ViewerErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey === state.resetKey) return null
    return { hasError: false, resetKey: props.resetKey }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logError('Viewer crashed', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="w-full h-full flex items-center justify-center text-sm text-slate-500 bg-slate-50/80">
          {this.props.message}
        </div>
      )
    }
    return this.props.children
  }
}
