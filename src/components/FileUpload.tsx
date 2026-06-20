import { useRef, useState, useCallback } from 'react'
import clsx from 'clsx'
import { formatBytes } from '../lib/format'

interface Props {
  onFile: (file: File) => void
  file: File | null
}

export function FileUpload({ onFile, file }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const isAccepted = (f: File) =>
    /\.(stl|3mf|step|stp|iges|igs|obj)$/i.test(f.name)

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const dropped = e.dataTransfer.files[0]
      if (dropped && isAccepted(dropped)) {
        onFile(dropped)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onFile],
  )

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0]
    if (picked) onFile(picked)
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={clsx(
        'relative flex flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed cursor-pointer transition-all select-none',
        'h-48 sm:h-64',
        dragging
          ? 'border-orca-500 bg-orca-50 scale-[1.01]'
          : file
          ? 'border-orca-400 bg-orca-50'
          : 'border-slate-300 bg-slate-50 hover:border-orca-400 hover:bg-orca-50',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".stl,.3mf,.step,.stp,.iges,.igs,.obj"
        className="hidden"
        onChange={handleChange}
      />

      {file ? (
        <>
          <ModelIcon className="w-12 h-12 text-orca-500" />
          <div className="text-center">
            <p className="font-semibold text-slate-800 truncate max-w-xs">{file.name}</p>
            <p className="text-sm text-slate-500">{formatBytes(file.size)}</p>
          </div>
          <p className="text-xs text-orca-600 font-medium">Click or drop to replace</p>
        </>
      ) : (
        <>
          <UploadIcon className="w-12 h-12 text-slate-400" />
          <div className="text-center">
            <p className="font-semibold text-slate-700">Drop your model here</p>
            <p className="text-sm text-slate-500 mt-1">or click to browse</p>
          </div>
          <p className="text-xs text-slate-400">.stl · .3mf · .step · .iges · .obj</p>
        </>
      )}
    </div>
  )
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
    </svg>
  )
}

function ModelIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
    </svg>
  )
}
