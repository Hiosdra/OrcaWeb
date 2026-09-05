import clsx from 'clsx'
import type { PlateAction } from '../types'
import { ModelIconSm, PlateIcon, SpinnerIcon, XIcon } from './icons'

interface Props {
  modelCount: number
  activeAction: PlateAction | null
  disabled?: boolean
  error?: string | null
  onAutoOrient: () => void
  onArrange: () => void
  onCancel?: () => void
}

/** Actions that change the engine-side placement of every object on the plate. */
export function PlateActions({
  modelCount,
  activeAction,
  disabled = false,
  error,
  onAutoOrient,
  onArrange,
  onCancel,
}: Props) {
  const busy = activeAction !== null
  const buttonsDisabled = disabled || busy || modelCount === 0

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-500 mr-1">
          Current plate · {modelCount} object{modelCount === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={onAutoOrient}
          disabled={buttonsDisabled}
          title="Auto orient objects on current plate"
          aria-label="Auto orient objects on current plate"
          data-testid="auto-orient-plate-button"
          className={clsx(
            'flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors',
            activeAction === 'auto-orient'
              ? 'border-orca-300 bg-orca-50 text-orca-600 cursor-wait'
              : buttonsDisabled
                ? 'border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed'
                : 'border-orca-200 bg-white text-orca-600 hover:bg-orca-50',
          )}
        >
          {activeAction === 'auto-orient' ? (
            <SpinnerIcon className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <ModelIconSm className="w-3.5 h-3.5" />
          )}
          {activeAction === 'auto-orient' ? 'Auto orienting current plate…' : 'Auto orient objects on current plate'}
        </button>
        <button
          type="button"
          onClick={onArrange}
          disabled={buttonsDisabled}
          title="Arrange objects on current plate"
          aria-label="Arrange objects on current plate"
          data-testid="arrange-plate-button"
          className={clsx(
            'flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors',
            activeAction === 'arrange'
              ? 'border-orca-300 bg-orca-50 text-orca-600 cursor-wait'
              : buttonsDisabled
                ? 'border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed'
                : 'border-orca-200 bg-white text-orca-600 hover:bg-orca-50',
          )}
        >
          {activeAction === 'arrange' ? (
            <SpinnerIcon className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <PlateIcon className="w-3.5 h-3.5" />
          )}
          {activeAction === 'arrange' ? 'Arranging current plate…' : 'Arrange objects on current plate'}
        </button>
        {busy && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-500 hover:border-red-200 hover:text-red-500"
          >
            <XIcon className="w-3.5 h-3.5" />
            Cancel
          </button>
        )}
      </div>
      {error && (
        <p role="alert" data-testid="plate-action-error" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}
