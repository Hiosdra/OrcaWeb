import { useRef, useState, useCallback } from 'react'
import clsx from 'clsx'

interface Props {
  onFiles: (files: File[]) => void
  loadedCount: number
}

export function FileUpload({ onFiles, loadedCount }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const isAccepted = (f: File) =>
    /\.(stl|3mf|obj|step|stp|iges|igs)$/i.test(f.name)

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const dropped = Array.from(e.dataTransfer.files).filter(isAccepted)
      if (dropped.length > 0) onFiles(dropped)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onFiles],
  )

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []).filter(isAccepted)
    if (picked.length > 0) onFiles(picked)
    e.target.value = ''
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={clsx(
        'relative flex flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed cursor-pointer transition-all select-none',
        'h-40 sm:h-52',
        dragging
          ? 'border-orca-500 bg-orca-50 scale-[1.01]'
          : loadedCount > 0
          ? 'border-orca-400 bg-orca-50'
          : 'border-slate-300 bg-slate-50 hover:border-orca-400 hover:bg-orca-50',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".stl,.3mf,.obj,.step,.stp,.iges,.igs"
        multiple
        className="hidden"
        onChange={handleChange}
      />

      {loadedCount > 0 ? (
        <>
          <UploadIcon className="w-10 h-10 text-orca-500" />
          <div className="text-center">
            <p className="font-semibold text-slate-800">
              {loadedCount} {loadedCount === 1 ? 'file' : 'files'} loaded
            </p>
            <p className="text-sm text-slate-500 mt-1">Click or drop to add more</p>
          </div>
        </>
      ) : (
        <>
          <UploadIcon className="w-12 h-12 text-slate-400" />
          <div className="text-center">
            <p className="font-semibold text-slate-700">Drop your models here</p>
            <p className="text-sm text-slate-500 mt-1">or click to browse · multiple files supported</p>
          </div>
          <p className="text-xs text-slate-400">.stl · .3mf · .obj · .step · .iges</p>
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
