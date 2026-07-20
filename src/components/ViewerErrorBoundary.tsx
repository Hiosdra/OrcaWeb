import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logError } from '../lib/log'

interface Props {
  children: ReactNode
  message: string
}

interface State {
  hasError: boolean
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

  static getDerivedStateFromError(): State {
    return { hasError: true }
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
