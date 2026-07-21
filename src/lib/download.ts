// Shared "save this Blob as a file" helper — used by SliceCards.tsx (G-code,
// zip, .3mf downloads) and SettingsPanel.tsx (settings .json export).
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
