import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState } from 'react'
import { UploadIcon } from './icons'

interface Props {
  onFiles: (files: File[]) => void
  loadedCount: number
}

const isAccepted = (f: File) => /\.(stl|3mf|obj|step|stp)$/i.test(f.name)

export function FileUpload({ onFiles, loadedCount }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  // Counter instead of a boolean: dragging over child elements fires
  // dragleave on the parent, which made the highlight flicker.
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [rejected, setRejected] = useState<string[]>([])

  useEffect(() => {
    if (rejected.length === 0) return
    const id = setTimeout(() => setRejected([]), 5000)
    return () => clearTimeout(id)
  }, [rejected])

  const takeFiles = useCallback(
    (files: File[]) => {
      const accepted = files.filter(isAccepted)
      setRejected(files.filter((f) => !isAccepted(f)).map((f) => f.name))
      if (accepted.length > 0) onFiles(accepted)
    },
    [onFiles],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      takeFiles(Array.from(e.dataTransfer.files))
    },
    [takeFiles],
  )

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    takeFiles(Array.from(e.target.files ?? []))
    e.target.value = ''
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept=".stl,.3mf,.obj,.step,.stp"
        multiple
        className="hidden"
        onChange={handleChange}
        data-testid="model-file-input"
      />

      <button
        type="button"
        onDragEnter={(e) => {
          e.preventDefault()
          dragDepth.current++
          setDragging(true)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          dragDepth.current--
          if (dragDepth.current <= 0) {
            dragDepth.current = 0
            setDragging(false)
          }
        }}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={clsx(
          'relative flex flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed cursor-pointer transition-all select-none w-full',
          'h-40 sm:h-52',
          dragging
            ? 'border-orca-500 bg-orca-50 scale-[1.01]'
            : loadedCount > 0
              ? 'border-orca-400 bg-orca-50'
              : 'border-slate-300 bg-slate-50 hover:border-orca-400 hover:bg-orca-50',
        )}
      >
        {loadedCount > 0 ? (
          <>
            <UploadIcon className="w-10 h-10 text-orca-500" />
            {/* span, not div/p: a <button>'s content model is phrasing content only */}
            <span className="block text-center">
              <span className="block font-semibold text-slate-800">
                {loadedCount} {loadedCount === 1 ? 'file' : 'files'} loaded
              </span>
              <span className="block text-sm text-slate-500 mt-1">Click or drop to add more</span>
            </span>
          </>
        ) : (
          <>
            <UploadIcon className="w-12 h-12 text-slate-400" />
            <span className="block text-center">
              <span className="block font-semibold text-slate-700">Drop your models here</span>
              <span className="block text-sm text-slate-500 mt-1">or click to browse · multiple files supported</span>
            </span>
            <span className="block text-xs text-slate-400">.stl · .3mf · .obj · .step</span>
          </>
        )}
      </button>

      {rejected.length > 0 && (
        <p className="mt-2 text-xs text-red-500 px-2">
          Unsupported file type{rejected.length !== 1 ? 's' : ''} skipped: {rejected.join(', ')} — supported: .stl,
          .3mf, .obj, .step
        </p>
      )}
    </div>
  )
}
